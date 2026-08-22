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
import { request as httpRequest } from 'node:http';
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

/**
 * A take is answered when it is over, which for a narrated episode is six and a half minutes after
 * the request goes out. Node's fetch gives up on a response after five, and it gave up in the
 * middle of one — the recorder stopped, the game carried on building, and the only sign was a
 * HeadersTimeoutError with nothing in it about takes. node:http has no such clock unless one is
 * set, so the long request goes through that instead.
 */
function requestWithoutDeadline(url, { method, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ ok: response.statusCode < 400, status: response.statusCode, text }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function control(path, { method = 'GET', body } = {}) {
  const response = await requestWithoutDeadline(`${CONTROL}${path}`, { method, body });
  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${parsed.error ?? text}`);
  return parsed;
}

/** Like run(), but hands back what the command said — ffmpeg reports measurements on stderr. */
function saidBy(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
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

/** What a beat measures, in LUFS, when the levelling is done. Roughly where streaming sits. */
const NARRATION_TARGET = -16;

/**
 * How far under the voice the game's own sounds sit. Fifteen is enough to hear a block land and a
 * belt turn without competing with a sentence — and the game audio is already recorded at about
 * that distance below a speaking voice, so most of the time this changes very little.
 */
const GAME_BELOW = 15;

/** Integrated loudness of a file, in LUFS. */
async function loudness(path) {
  const output = await saidBy('ffmpeg', ['-nostats', '-hide_banner', '-i', path,
    '-map', '0:a:0', '-filter:a', 'ebur128', '-f', 'null', '-']);
  // The last one, not the first. ebur128 prints a running value as it goes and the very first is
  // -70 — silence before the first sound. Reading that as the file's loudness asks for fifty-four
  // decibels of gain, which the limiter then flattens into a wall.
  const all = [...output.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)];
  if (!all.length) throw new Error(`could not measure the loudness of ${path}`);
  return Number(all[all.length - 1][1]);
}

/**
 * Lays the narration over the recording — over, not instead of.
 *
 * This used to map the voice in and drop the recording's own audio on the floor, which threw away
 * every sound the machine makes: the block landing, the belt turning, the water wheel. Both are
 * kept now, the voice on top and the game underneath it.
 *
 * Levels are measured rather than assumed. ElevenLabs returns audio around -29 LUFS and the game
 * capture sits near -32, and both are far below where anything else a viewer watches is; guessing
 * a gain would have meant guessing again the next time either changed.
 *
 * The offset is the point of the delay. Recording starts before the take does, so dropping the
 * narration in at zero puts every word a second and a half ahead of the block it describes.
 * `leadMs` is measured, not assumed: the wall clock between the recorder reporting "rolling" and
 * the run request going out. adelay pads with real silence rather than shifting with `-itsoffset`,
 * which leaves the audio starting at a non-zero timestamp — players that ignore an edit list then
 * play the video silently, which is exactly what happened in the Claude phone app.
 *
 * No `-shortest` either: that trimmed the video down to the narration and threw away the tail
 * where the finished contraption is actually on screen.
 */
async function mux({ video, voice, out, leadMs }) {
  await mkdir(dirname(out), { recursive: true });
  const voiceGain = NARRATION_TARGET - await loudness(voice);
  const gameGain = (NARRATION_TARGET - GAME_BELOW) - await loudness(video);
  console.log(`levelling: voice ${voiceGain >= 0 ? '+' : ''}${voiceGain.toFixed(1)} dB, `
    + `game ${gameGain >= 0 ? '+' : ''}${gameGain.toFixed(1)} dB`);

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-i', voice,
    '-filter_complex',
    `[1:a]adelay=delays=${Math.round(leadMs)}:all=1,volume=${voiceGain.toFixed(2)}dB[speech];`
    + `[0:a]volume=${gameGain.toFixed(2)}dB[room];`
    + `[speech][room]amix=inputs=2:duration=first:normalize=0,`
    // A limiter rather than another loudnorm pass: the two tracks are already where they should
    // be, and all that is left is to stop a press and a consonant landing together from clipping.
    + `alimiter=limit=0.89:level=disabled[mixed]`,
    '-map', '0:v:0', '-map', '[mixed]',
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
