/**
 * The storyboard as lanes on a clock: what is spoken, what the camera does, what is built, and
 * what happens to the world.
 *
 * A storyboard is a flat list of cues in the order they were written, which is the right shape for
 * a document and the wrong shape for a picture. Sorting them by kind is the whole difference
 * between "forty-four cues" and "at two minutes thirteen the camera is arcing past the boiler
 * while the sorting bay goes up and the voice is on its third sentence".
 *
 * The sorting lives here rather than in the front end so that the same four lanes are available to
 * an agent through one operation. A layout that only exists as JSX can only be looked at.
 */

/** Which lane each cue type belongs in. Every one of the twelve is spoken for. */
const LANES = {
  camera: 'camera',
  place: 'build',
  fill: 'build',
  setBlocks: 'build',
  entities: 'build',
  screen: 'world',
  showFilter: 'world',
  use: 'world',
  reseat: 'world',
  gameMode: 'world',
  materialsChest: 'world',
  marker: 'world',
};

/** The lane a cue type belongs to, or null for one nobody has taught this about yet. */
export function laneOf(type) {
  return LANES[type] ?? null;
}

/**
 * How long a cue occupies the timeline.
 *
 * A placement lasts however long its blocks are spread over — `spanMs` when one is given, and the
 * stagger times the gaps between blocks when it is not. Everything but a camera move and a
 * placement is a moment.
 *
 * A camera move is the awkward one, because a storyboard says how long it lasts in three different
 * ways and none of them is a number of milliseconds. This mirrors `tools/make-timeline.mjs`,
 * which is the thing that actually compiles them:
 *
 *   `at` and `until`   a window inside one beat, as fractions of it
 *   `spanBeats`        that many whole beats from this one
 *   neither            exactly this beat
 *
 * @param beats every beat in order, so `spanBeats` can add the next ones up
 */
export function lengthOf(cue, blocks, beats = []) {
  if (cue.type === 'camera') return cameraLength(cue, beats);
  if (cue.spanMs > 0) return cue.spanMs;
  if (cue.staggerMs > 0 && blocks > 1) return cue.staggerMs * (blocks - 1);
  return 0;
}

/** A beat's length, measured if it has been spoken and estimated if it has not. */
const beatLength = (beat) => beat?.measuredMs ?? beat?.plannedMs ?? 0;

function cameraLength(cue, beats) {
  const at = beats.findIndex((beat) => beat.id === cue.beat);
  if (at === -1) return cue.durationMs ?? 0;
  if (typeof cue.at === 'number') {
    return Math.round(((cue.until ?? 1) - cue.at) * beatLength(beats[at]));
  }
  return beats.slice(at, at + (cue.spanBeats ?? 1)).reduce((sum, beat) => sum + beatLength(beat), 0);
}

/** What to write on the bar: the cue's own note if it has one, else what it does. */
function labelOf(cue, blocks) {
  if (cue._what) return cue._what;
  if (cue.type === 'place') return `${blocks} blocks`;
  if (cue.type === 'marker') return cue.label ?? 'marker';
  if (cue.type === 'screen') return `screen ${cue.action ?? ''}`.trim();
  if (cue.type === 'gameMode') return `game mode ${cue.mode ?? ''}`.trim();
  return cue.type;
}

/**
 * Lanes for one storyboard.
 *
 * @param cues     the cues as `cues_list` resolves them — with `atMsResolved` and `blocksResolved`
 * @param beats    from `pipeline.beats()`, so each carries its text and whether it was spoken
 * @param sentences from `narration.track()`, the lines with absolute times
 */
export function lanes({ cues, beats, sentences }) {
  const narration = [];
  for (const beat of sentences?.beats ?? []) {
    for (const line of beat.lines) narration.push({ beat: beat.id, ...line });
  }

  const out = { narration, camera: [], build: [], world: [] };
  const unlaned = [];

  for (const cue of cues) {
    const lane = laneOf(cue.type);
    if (!lane) {
      unlaned.push({ index: cue.index, type: cue.type });
      continue;
    }
    const blocks = cue.blocksResolved?.count ?? 0;
    const fromMs = cue.atMsResolved;
    // A cue on an unspoken beat has no millisecond at all. It is reported rather than dropped:
    // a bar that quietly does not appear is how a cue gets lost.
    const entry = {
      index: cue.index,
      type: cue.type,
      beat: cue.beat ?? null,
      at: cue.at ?? null,
      fromMs,
      toMs: fromMs === null ? null : fromMs + lengthOf(cue, blocks, beats),
      label: labelOf(cue, blocks),
      timed: fromMs !== null,
    };
    if (cue.type === 'camera') {
      entry.ease = cue.ease ?? 'inOut';
      entry.keyframes = cue.keyframes?.length ?? 0;
    }
    if (blocks) {
      entry.blocks = blocks;
      entry.describe = cue.blocksResolved.describe;
      entry.error = cue.blocksResolved.error;
    }
    out[lane].push(entry);
  }

  for (const lane of ['camera', 'build', 'world']) {
    out[lane].sort((a, b) => (a.fromMs ?? Infinity) - (b.fromMs ?? Infinity));
  }

  const spoken = beats.map((beat) => ({
    id: beat.id,
    text: beat.text ?? null,
    state: beat.state,
    measuredMs: beat.measuredMs,
    plannedMs: beat.plannedMs ?? null,
    startMs: beat.startMs ?? null,
  }));

  return {
    beats: spoken,
    totalMs: sentences?.totalMs
      ?? spoken.reduce((sum, beat) => sum + (beat.measuredMs ?? beat.plannedMs ?? 0), 0),
    lanes: out,
    unlaned,
  };
}
