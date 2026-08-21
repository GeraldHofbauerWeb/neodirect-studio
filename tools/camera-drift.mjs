/**
 * Measures how far the camera strays from the path the script gave it.
 *
 *   node tools/camera-drift.mjs script/probe.json
 *
 * Written to settle an argument that could not be settled by watching: the camera stuttered when a
 * shot passed through the build, and the client log was clean. It was clean because the server
 * suppresses the "moved wrongly!" warning in creative mode — it was still teleporting the player
 * back out of the blocks, silently, and discarding position packets for up to twenty ticks each
 * time. This asks the game where the camera actually is, often, and compares.
 *
 * The comparison is distance to the *curve*, not distance to the point the clock says. Skew
 * between the take clock and the poll moves the camera along the path and means nothing; a
 * correction pushes it off the path, and that is what this measures.
 */

import { readFile } from 'node:fs/promises';
import { samplePath } from './frame-parts.mjs';

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mirrors CameraPath.easeInOut in the mod. The curve itself comes from frame-parts. */
const easeInOut = (t) => t * t * (3 - 2 * t);

/** The whole curve, densely, so a probe can be matched to its nearest point on it. */
function curve(keyframes, steps = 600) {
  const points = [];
  for (let i = 0; i <= steps; i++) points.push(samplePath(keyframes, easeInOut(i / steps)));
  return points;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const offPath = (eye, points) => points.reduce((m, p) => Math.min(m, distance(eye, p)), Infinity);

const [timelinePath] = process.argv.slice(2);
if (!timelinePath) throw new Error('usage: node tools/camera-drift.mjs <timeline.json>');
const body = await readFile(timelinePath, 'utf8');
const timeline = JSON.parse(body);

const moves = timeline.cues
  .filter((c) => c.type === 'camera')
  .map((c) => ({ atMs: c.atMs, endMs: c.atMs + (c.durationMs ?? 3000), what: c._what ?? '',
                 points: curve(c.keyframes), worst: 0, samples: 0 }));

const started = Date.now();
const running = fetch(`${CONTROL}/run`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
}).then((r) => r.json());

let sawPose = null;
let sawNoPhysics = null;
let done = false;
running.finally(() => { done = true; });

while (!done) {
  const health = await fetch(`${CONTROL}/health`).then((r) => r.json()).catch(() => null);
  if (health?.eye) {
    sawPose = health.pose;
    sawNoPhysics = health.noPhysics;
    const elapsed = Date.now() - started;
    for (const move of moves) {
      // Strictly inside the cue, and not the first half second of it. The take clock starts on the
      // first server tick after arming and the client picks the move up a tick later still, so the
      // opening moments are the camera still parked at the end of the previous shot — counting
      // those measures the cut between two shots, not the drift within one.
      if (elapsed < move.atMs + 600 || elapsed > move.endMs - 100) continue;
      move.worst = Math.max(move.worst, offPath(health.eye, move.points));
      move.samples++;
    }
  }
  await sleep(80);
}

const log = await running;
if (log.error) throw new Error(log.error);

console.log(`take ${log.take}: ${log.actualDurationMs} ms`);
console.log(`camera body: pose ${sawPose}, noPhysics ${sawNoPhysics}\n`);
let worst = 0;
for (const move of moves) {
  worst = Math.max(worst, move.worst);
  console.log(`${String(move.atMs).padStart(7)} ms  ${move.samples.toString().padStart(3)} probes  `
    + `off path ${move.worst.toFixed(3)}  ${move.what.slice(0, 44)}`);
}
console.log(`\nworst deviation from the scripted path: ${worst.toFixed(3)} blocks`);
