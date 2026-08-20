/**
 * Builds a runnable timeline from a storyboard and the measured narration.
 *
 *   node tools/make-timeline.mjs script/episode.storyboard.json script/episode.json
 *
 * This is the step the whole project is arranged around. A storyboard says *where in a beat*
 * something happens — "three quarters of the way through beat one, the deployer goes down" — and
 * this resolves that against the audio that actually came back from ElevenLabs. Rewrite a
 * sentence, re-render, run this, and the choreography follows the new timing by itself.
 *
 * Positions inside a beat are fractions rather than milliseconds on purpose: a voice 20% faster
 * than the estimate should compress the whole beat proportionally, not leave the last placement
 * stranded past the end of the narration. (Chris turned out to be exactly that much faster than
 * the hand estimate, which is how this stopped being a theoretical concern.)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [storyboardPath, outPath] = process.argv.slice(2);
if (!storyboardPath || !outPath) {
  throw new Error('usage: node tools/make-timeline.mjs <storyboard.json> <out.json>');
}

const storyboard = JSON.parse(await readFile(storyboardPath, 'utf8'));
const beatsPath = resolve(dirname(storyboardPath), storyboard.beats);
const script = JSON.parse(await readFile(beatsPath, 'utf8'));

const beats = new Map();
for (const beat of script.beats) {
  if (beat.measuredMs == null || beat.startMs == null) {
    throw new Error(`beat ${beat.id} has no measured audio yet — run "render-voice.mjs render" first`);
  }
  beats.set(beat.id, beat);
}

const cues = [];
for (const cue of storyboard.cues) {
  const { beat: beatId, at, ...rest } = cue;

  if (beatId == null) {
    if (rest.atMs == null) throw new Error(`cue without a beat needs an absolute atMs: ${JSON.stringify(cue)}`);
    cues.push(rest);
    continue;
  }

  const beat = beats.get(beatId);
  if (!beat) throw new Error(`storyboard references unknown beat "${beatId}"`);

  if (rest.type === 'camera') {
    // A camera move owns its whole beat unless it is given an `at`/`until` window. The window
    // matters when a beat changes subject partway through — the narration turning from the drill
    // face to the one deployer in the middle should not leave the camera pointed at the drills.
    if (at != null) {
      const until = cue.until ?? 1;
      if (until <= at) throw new Error(`camera "until" must come after "at": ${JSON.stringify(cue)}`);
      const start = beat.startMs + at * beat.measuredMs;
      const end = beat.startMs + Math.min(until, 1) * beat.measuredMs;
      const resolved = { ...rest, atMs: Math.round(start), durationMs: Math.round(end - start) };
      delete resolved.until;
      cues.push(resolved);
      continue;
    }

    const spans = cue.spanBeats ?? 1;
    const ids = script.beats.map((b) => b.id);
    const first = ids.indexOf(beatId);
    const last = Math.min(first + spans - 1, ids.length - 1);
    const endBeat = beats.get(ids[last]);
    const resolved = {
      ...rest,
      atMs: beat.startMs,
      durationMs: endBeat.startMs + endBeat.measuredMs - beat.startMs,
    };
    delete resolved.spanBeats;
    cues.push(resolved);
    continue;
  }

  if (at == null) throw new Error(`cue in beat ${beatId} needs "at" (0..1): ${JSON.stringify(cue)}`);
  if (at < 0 || at > 1) throw new Error(`"at" must be a fraction between 0 and 1, got ${at}`);
  cues.push({ ...rest, atMs: Math.round(beat.startMs + at * beat.measuredMs) });
}

cues.sort((a, b) => a.atMs - b.atMs);

const timeline = {
  take: storyboard.take,
  _generated: `from ${storyboard.beats} — do not edit by hand, edit the storyboard and re-run make-timeline.mjs`,
  schematic: storyboard.schematic,
  parts: storyboard.parts,
  origin: storyboard.origin,
  clearStage: storyboard.clearStage ?? true,
  presentation: storyboard.presentation,
  cues: [...cues, { atMs: script.totalMs, type: 'marker', label: 'end of narration' }],
};

await writeFile(outPath, JSON.stringify(timeline, null, 2) + '\n');

console.log(`${script.beats.length} beats, ${script.totalMs} ms of narration`);
for (const beat of script.beats) {
  console.log(`  ${beat.id}: ${String(beat.startMs).padStart(6)} .. ${String(beat.startMs + beat.measuredMs).padStart(6)} ms`);
}
console.log(`\n${timeline.cues.length} cues written to ${outPath}`);
