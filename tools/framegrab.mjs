/**
 * Shoots a take by pulling frames out of the game's own framebuffer, then assembles them with
 * ffmpeg.
 *
 *   node tools/framegrab.mjs script/pilot-b.json out/B.mp4
 *
 * Why this exists: on a Wayland session `x11grab` records pure black — XWayland does not hand
 * another client's pixels to a screen grabber — so the obvious ffmpeg route is a dead end here.
 * OBS works (it goes through the PipeWire portal) but has to be installed. This path needs
 * nothing at all: the mod grabs its own framebuffer, which is also the only source guaranteed to
 * contain exactly what the game drew and nothing that happened to overlap the window.
 *
 * The rate is capped by the mod's per-tick grab hook at roughly 19 fps, so this is a preview-grade
 * result rather than a delivery master. Each frame's real elapsed time is recorded and fed to
 * ffmpeg as a per-frame duration, so the motion plays back at true speed even though the grab
 * rate wobbles.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';
const OUTPUT_FPS = 30;

const [timelinePath, outPath = 'out/take.mp4'] = process.argv.slice(2);
if (!timelinePath) throw new Error('usage: node tools/framegrab.mjs <timeline.json> [out.mp4]');

const timeline = await (await import('node:fs/promises')).readFile(timelinePath, 'utf8');
const take = JSON.parse(timeline).take ?? 'take';

function run(command, args) {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (c) => (c === 0 ? res() : rej(new Error(`${command} exited ${c}:\n${err.slice(-1500)}`))));
  });
}

const health = await fetch(`${CONTROL}/health`).then((r) => r.json());
if (health.running) throw new Error('the director is already running a take');

const frames = [];
let grabbing = true;

// Grab in a tight loop: the mod serves one per client tick, so the loop self-throttles and there
// is no interval to tune.
const grabber = (async () => {
  const started = Date.now();
  while (grabbing) {
    try {
      const body = await (await fetch(`${CONTROL}/screenshot`)).json();
      if (body.path) frames.push({ at: Date.now() - started, path: body.path });
    } catch {
      // A grab can fail while the game is busy; skipping one frame is preferable to aborting.
    }
  }
})();

const log = await fetch(`${CONTROL}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: timeline,
}).then((r) => r.json());

grabbing = false;
await grabber;

if (log.error) throw new Error(log.error);
console.log(`take ${log.take}: ${log.actualDurationMs} ms, ${frames.length} frames (${(frames.length / (log.actualDurationMs / 1000)).toFixed(1)} fps)`);
if (frames.length < 10) throw new Error('too few frames captured to assemble a video');

// ffmpeg's concat demuxer takes a duration per entry, which keeps real timing even though the
// grab rate is uneven. The last frame needs an explicit duration and a repeated entry, which is
// the documented quirk of the format.
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1];
  const duration = ((next ? next.at : frames[i].at + 50) - frames[i].at) / 1000;
  lines.push(`file '${resolve(frames[i].path)}'`, `duration ${duration.toFixed(4)}`);
}
lines.push(`file '${resolve(frames[frames.length - 1].path)}'`);

const listPath = `out/${take}.frames.txt`;
await mkdir('out', { recursive: true });
await writeFile(listPath, lines.join('\n'));

await mkdir(dirname(outPath), { recursive: true });
await run('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', listPath,
  '-vsync', 'cfr', '-r', String(OUTPUT_FPS),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-pix_fmt', 'yuv420p',
  outPath,
]);
console.log(`wrote ${outPath}`);
