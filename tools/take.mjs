/**
 * Shoots one take end to end.
 *
 *   node tools/take.mjs script/pilot-a.json [--capture x11|obs|none] [--voice out/beat1.mp3]
 *
 * Sequence: start recording, hand the timeline to the director, wait for its take log, stop
 * recording, then mux the narration on top. The director's log carries the real millisecond a cue
 * fired, which is what makes the audio line up rather than merely start at the same time.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Obs } from './obs.mjs';
import { Capture } from './capture.mjs';

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';

/** OBS needs a moment between "recording" and "actually writing frames". */
const RECORD_LEAD_MS = 1500;
const RECORD_TAIL_MS = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a file stops growing, so a still-remuxing recording is never read as truncated. */
async function settled(path, { quietMs = 700, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const { size } = await stat(path).catch(() => ({ size: -1 }));
    if (size > 0 && size === previous) return;
    previous = size;
    await sleep(quietMs);
  }
  console.warn(`warning: ${path} was still changing after ${timeoutMs} ms`);
}

function parseArgs(argv) {
  // OBS by default. x11grab needs nothing but ffmpeg and was the original default, but under
  // Wayland it records 1920x1080 of pure black: XWayland does not hand one client's pixels to
  // another. It fails silently — the take runs, the file is written, and only watching it reveals
  // there is nothing in it. Left available with --capture x11 for an X11 session, where it works.
  const args = { timeline: null, capture: 'obs', out: null, voice: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capture') args.capture = argv[++i];
    else if (a === '--no-capture') args.capture = 'none';
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--voice') args.voice = argv[++i];
    else if (!args.timeline) args.timeline = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!args.timeline) {
    throw new Error('usage: node tools/take.mjs <timeline.json> [--capture x11|obs|none] [--out file.mp4] [--voice audio.mp3]');
  }
  if (!['x11', 'obs', 'none'].includes(args.capture)) {
    throw new Error(`unknown capture mode: ${args.capture}`);
  }
  // Refuse rather than record black. This mistake costs a full take to discover otherwise, since
  // nothing about the run looks wrong until someone opens the file.
  if (args.capture === 'x11' && process.env.XDG_SESSION_TYPE === 'wayland') {
    throw new Error('x11grab records black under Wayland — use --capture obs');
  }
  return args;
}

async function control(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${CONTROL}${path}`, {
    method,
    body,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${parsed.error ?? text}`);
  return parsed;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}:\n${stderr.slice(-2000)}`)));
  });
}

/**
 * Lays the narration over the recording. Video is copied, not re-encoded — this step should cost
 * seconds, and the recording is already in its final quality.
 *
 * The offset is the point. Recording starts before the take does, so dropping the narration in at
 * zero puts every word a second and a half ahead of the block it describes. `leadMs` is measured,
 * not assumed: the wall clock between the recorder reporting "rolling" and the run request going
 * out.
 *
 * No `-shortest` either — that trimmed the video down to the narration and threw away the tail
 * where the finished contraption is actually on screen.
 */
async function mux({ video, voice, out, leadMs }) {
  await mkdir(dirname(out), { recursive: true });
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-i', voice,
    '-map', '0:v:0', '-map', '1:a:0',
    // adelay pads the audio with real silence rather than shifting it with `-itsoffset`. Both
    // line the narration up, but -itsoffset leaves the audio track starting at a non-zero
    // timestamp, and players that ignore an edit list then play the video silently — which is
    // exactly what happened in the Claude phone app.
    '-af', `adelay=delays=${Math.round(leadMs)}:all=1`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    out,
  ]);
}

const args = parseArgs(process.argv.slice(2));
const timeline = await readFile(args.timeline, 'utf8');
const take = JSON.parse(timeline).take ?? basename(args.timeline, '.json');

const health = await control('/health');
if (health.running) throw new Error('the director is already running a take');
console.log(`director ready (take ${take})`);

let obs = null;
let capture = null;
let recording = null;
// Wall clock at the moment frames start landing in the file. Everything the narration has to line
// up against is measured from here.
let recordingStarted = null;

if (args.capture === 'obs') {
  obs = await Obs.connect();
  await obs.startRecord();
  recordingStarted = Date.now();
  console.log('OBS recording');
  await sleep(RECORD_LEAD_MS);
} else if (args.capture === 'x11') {
  recording = args.out ?? join('out', `${take}.raw.mp4`);
  capture = await Capture.start(recording, { fps: 60, control: CONTROL });
  recordingStarted = Date.now();
  await sleep(RECORD_LEAD_MS);
}

let log;
let leadMs = 0;
try {
  leadMs = recordingStarted === null ? 0 : Date.now() - recordingStarted;
  log = await control('/run', { method: 'POST', body: timeline });
  console.log(`take done: ${log.actualDurationMs} ms (planned ${log.plannedDurationMs} ms), recording lead ${leadMs} ms`);
} finally {
  await sleep(RECORD_TAIL_MS);
  if (obs) {
    recording = await obs.stopRecord();
    obs.close();
    // OBS names files by timestamp and finishes remuxing hybrid_mp4 shortly after StopRecord
    // returns, so wait for the size to settle before renaming it to something readable.
    await settled(recording);
    const named = join('out', `take-${take}.mp4`);
    await rename(recording, named);
    recording = named;
    console.log(`OBS wrote ${recording}`);
  } else if (capture) {
    await capture.stop();
    console.log(`ffmpeg wrote ${recording}`);
  }
}

// The log is the record of what actually happened, and the input to any later cutting.
const logPath = join('out', `${take}.log.json`);
await mkdir('out', { recursive: true });
await writeFile(logPath, JSON.stringify({ ...log, recording, recordLeadMs: leadMs }, null, 2));
console.log(`log written to ${logPath}`);

const drift = log.events.filter((e) => Math.abs(e.actualMs - e.plannedMs) > 250);
if (drift.length) {
  console.warn(`\n${drift.length} cue(s) drifted more than 250 ms from plan:`);
  for (const e of drift) console.warn(`  ${e.kind} planned ${e.plannedMs} -> actual ${e.actualMs} (${e.detail})`);
}

if (args.voice && recording) {
  const out = join('out', `${take}.mp4`);
  await mux({ video: recording, voice: args.voice, out, leadMs });
  console.log(`muxed to ${out}`);
}
