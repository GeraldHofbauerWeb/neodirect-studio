/**
 * The lanes, the sentences, and the arithmetic that puts a bar where it belongs.
 *
 * These run against the real ore-plant documents rather than fixtures: the point of the lanes is
 * that they describe *this* episode correctly, and a fixture that agrees with the code proves
 * nothing about the storyboard on disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { laneOf, lengthOf } from '../lib/tracks.mjs';
import { track, sentenceAt } from '../lib/narration.mjs';
import { offsetsFor, weightOf } from '../lib/placements.mjs';
import { invoke } from '../lib/ops.mjs';
import { subtitlesFor } from '../../tools/render-voice.mjs';
import { readJson, readText } from '../lib/docs.mjs';
import { resolve } from '../lib/paths.mjs';

/** Every cue type the director knows. A new one must be given a lane, not silently dropped. */
const CUE_TYPES = ['place', 'camera', 'entities', 'materialsChest', 'fill', 'showFilter',
  'screen', 'setBlocks', 'use', 'reseat', 'gameMode', 'marker'];

test('every cue type belongs to exactly one lane', () => {
  for (const type of CUE_TYPES) {
    const lane = laneOf(type);
    assert.ok(lane, `${type} has no lane — the timeline would draw the episode without it`);
    assert.ok(['camera', 'build', 'world'].includes(lane));
  }
  assert.equal(laneOf('somethingNew'), null, 'an unknown type is reported, not guessed at');
});

test('a camera move lasts its window, a placement its spread', () => {
  const beats = [{ id: 'b0', measuredMs: 20_000 }, { id: 'b1', measuredMs: 10_000 }];

  // The whole beat when nothing says otherwise.
  assert.equal(lengthOf({ type: 'camera', beat: 'b0' }, 0, beats), 20_000);
  // Half of it, when it is given a window.
  assert.equal(lengthOf({ type: 'camera', beat: 'b0', at: 0.25, until: 0.75 }, 0, beats), 10_000);
  // Two beats, when it spans them.
  assert.equal(lengthOf({ type: 'camera', beat: 'b0', spanBeats: 2 }, 0, beats), 30_000);
  // No beat at all: an absolute cue says how long it lasts itself.
  assert.equal(lengthOf({ type: 'camera', durationMs: 4000 }, 0, beats), 4000);

  assert.equal(lengthOf({ type: 'place', spanMs: 9000 }, 600, beats), 9000);
  assert.equal(lengthOf({ type: 'place', staggerMs: 100 }, 5, beats), 400, 'four gaps between five blocks');
  assert.equal(lengthOf({ type: 'marker' }, 0, beats), 0, 'a marker is a moment');
});

test('the ore plant reads as four lanes with nothing left over', async () => {
  const track = await invoke('timeline_track', { slug: 'ore-plant' });
  assert.deepEqual(track.unlaned, [], 'every cue found a lane');
  assert.ok(track.lanes.narration.length > 50, 'the narration is broken into sentences');
  assert.ok(track.lanes.camera.length > 0 && track.lanes.build.length > 0);

  for (const lane of ['camera', 'build']) {
    for (const entry of track.lanes[lane]) {
      if (!entry.timed) continue;
      assert.ok(entry.toMs >= entry.fromMs, `${entry.label} ends before it starts`);
      assert.ok(entry.label && entry.label.length > 0, 'every bar says what it is');
    }
  }
  // Sorted, because a lane drawn out of order is a lane that cannot be read along.
  const starts = track.lanes.camera.map((entry) => entry.fromMs);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test('the sentences are the ones the viewer will read, at the same times', async () => {
  const narration = await track('script/ore-plant.beats.json');
  const { text: srt } = await readText(`${narration.voice}/subtitles.srt`);

  const fromSrt = srt.split('\n\n').filter((block) => block.trim()).map((block) => {
    const [, stamps, ...text] = block.split('\n');
    return { stamps, text: text.join(' ').trim() };
  });
  const ours = narration.beats.flatMap((beat) => beat.lines);

  assert.equal(ours.length, fromSrt.length, 'the same number of lines as the subtitle track');
  assert.equal(ours[0].text, fromSrt[0].text);
  assert.equal(ours[ours.length - 1].text, fromSrt[fromSrt.length - 1].text);

  // And the split itself is unchanged: toSrt now formats what lines() decides, so rebuilding the
  // track must reproduce the file on disk exactly.
  const { value: beats } = await readJson('script/ore-plant.beats.json');
  const { srt: rebuilt } = await subtitlesFor(beats, resolve(narration.voice));
  assert.equal(rebuilt, srt, 'the subtitle track is byte-identical after the refactor');
});

test('every cue in the track is separated from the one before it', async () => {
  for (const file of ['out/voice/ore-plant/subtitles.srt', 'out/voice/pilot/subtitles.srt']) {
    const { text: srt } = await readText(file);
    const glued = srt.split('\n').filter((line, n, all) =>
      n > 0 && /^\d+$/.test(line) && all[n - 1] !== '');
    assert.deepEqual(glued, [], `${file} glues a cue to the one before it — not an .srt file`);
  }
});

test('a millisecond names the sentence being spoken at it', async () => {
  const narration = await track('script/ore-plant.beats.json');
  const first = narration.beats[0].lines[0];
  const found = sentenceAt(narration, first.fromMs + 10);
  assert.equal(found.text, first.text);
  assert.equal(sentenceAt(narration, narration.totalMs + 60_000), null, 'past the end is nothing');
});

test('an unspoken beat has no sentences, and says so', async () => {
  const narration = await track('script/ore-plant.beats.json');
  for (const beat of narration.beats) {
    if (!beat.spoken) assert.deepEqual(beat.lines, []);
    assert.ok(beat.toMs >= beat.fromMs);
  }
});

test('pace weights redistribute a cue without lengthening it', () => {
  const blocks = [
    { i: 0, pos: [0, 0, 0], id: 'minecraft:stone' },
    { i: 1, pos: [1, 0, 0], id: 'minecraft:stone' },
    { i: 2, pos: [2, 0, 0], id: 'create:cogwheel' },
  ];
  const pace = { default: 1, 'create:cogwheel': 6 };
  assert.equal(weightOf(pace, blocks[0]), 1);
  assert.equal(weightOf(pace, blocks[2]), 6, 'a component is worth more than a floor slab');
  assert.equal(weightOf({ '2,0,0': 9, ...pace }, blocks[2]), 9, 'a position beats a block id');

  const offsets = offsetsFor({ pace, spanMs: 6000 }, blocks);
  assert.equal(offsets[0], 0, 'the first block lands at the start');
  assert.equal(offsets[offsets.length - 1], 6000, 'and the last exactly at the end');
  assert.ok(offsets[1] < offsets[2], 'in order');

  // Even weights are the even spread they always were.
  const even = offsetsFor({ spanMs: 6000 }, blocks);
  assert.deepEqual(even, [0, 3000, 6000]);
});

test('every block of a take is timed exactly once', async () => {
  const timed = await invoke('placement_times', { slug: 'ore-plant', take: 'build' });
  assert.equal(timed.placed, 926, 'the whole plant is accounted for');
  assert.ok(timed.firstMs >= 0 && timed.lastMs > timed.firstMs);
});
