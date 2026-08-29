/**
 * The narration as it will actually be heard: every sentence, and when.
 *
 * A beat is thirty to fifty seconds long, so "which beat is playing" is not an answer to "which
 * sentence is playing" — and the sentence is what a cue is timed against. The alignments hold a
 * time for every character, so the answer is already on disk; it has only never been read.
 *
 * The line breaks come from `lines()` in tools/render-voice.mjs, which is the same function that
 * cuts the subtitle track. Deliberately: a timeline showing different sentences at different times
 * than the ones the viewer reads would be lying in a way that only a finished video could expose.
 */

import { readJson, readJsonIfPresent } from './docs.mjs';
import { lines, voiceDir } from '../../tools/render-voice.mjs';

/**
 * Every sentence of an episode, on the episode's own clock.
 *
 * @param beatsPath the beats document; the voice directory follows from it
 * @returns `{ totalMs, beats: [{id, text, fromMs, toMs, spoken, lines: [{fromMs, toMs, text}]}] }`
 */
export async function track(beatsPath) {
  const { value } = await readJson(beatsPath);
  const dir = voiceDir(beatsPath);

  const out = [];
  let at = 0;
  for (const beat of value.beats ?? []) {
    const alignment = await readJsonIfPresent(`${dir}/${beat.id}.alignment.json`);
    // An unspoken beat still occupies its estimate, or the cues after it would draw at the wrong
    // time — but it has no sentences, and it is marked so nothing pretends otherwise.
    const length = beat.measuredMs ?? beat.plannedMs ?? 0;
    const startMs = typeof beat.startMs === 'number' ? beat.startMs : at;
    out.push({
      id: beat.id,
      text: beat.text,
      fromMs: startMs,
      toMs: startMs + length,
      spoken: !!alignment,
      lines: alignment
        ? lines(alignment.value, { offsetSeconds: startMs / 1000 })
        : [],
    });
    at = startMs + length;
  }

  return { path: beatsPath, voice: dir, totalMs: at, beats: out };
}

/** The sentence being spoken at a millisecond, if any. What a playhead reads out. */
export function sentenceAt(narration, ms) {
  for (const beat of narration.beats) {
    for (const line of beat.lines) {
      if (ms >= line.fromMs && ms < line.toMs) return { beat: beat.id, ...line };
    }
  }
  return null;
}
