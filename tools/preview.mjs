/**
 * Runs a timeline and grabs frames at chosen moments — a contact sheet for a shot.
 *
 *   node tools/preview.mjs script/pilot-a.json 1000 8000 15000 22000 27500
 *
 * Framing is the thing you iterate on most, and starting OBS for every attempt is far too slow.
 * The grabs come from the game's own framebuffer, so they are exactly what the recording sees.
 */

import { readFile } from 'node:fs/promises';

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [timelinePath, ...marks] = process.argv.slice(2);
if (!timelinePath) {
  throw new Error('usage: node tools/preview.mjs <timeline.json> [ms ...]');
}
const at = marks.length ? marks.map(Number) : [1000, 8000, 15000, 22000, 27500];
at.sort((a, b) => a - b);

const timeline = await readFile(timelinePath, 'utf8');

const shots = [];
const running = fetch(`${CONTROL}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: timeline,
}).then((r) => r.json());

const started = Date.now();
for (const ms of at) {
  const wait = ms - (Date.now() - started);
  if (wait > 0) await sleep(wait);
  try {
    const response = await fetch(`${CONTROL}/screenshot`);
    const body = await response.json();
    shots.push({ ms, path: body.path ?? body.error });
    console.log(`${String(ms).padStart(6)} ms  ${body.path ?? 'ERROR: ' + body.error}`);
  } catch (e) {
    console.warn(`${String(ms).padStart(6)} ms  failed: ${e.message}`);
  }
}

const log = await running;
if (log.error) throw new Error(log.error);
console.log(`\ntake ${log.take}: ${log.actualDurationMs} ms (planned ${log.plannedDurationMs} ms)`);
