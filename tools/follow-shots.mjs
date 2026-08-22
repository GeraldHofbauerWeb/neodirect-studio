/**
 * The follow style, as cues: an assembly going up one block at a time with the camera close.
 *
 * Shared by the two things that shoot it. tools/mk-build-take.mjs paces itself — a fixed interval
 * per block, assemblies laid end to end. tools/mk-episode.mjs is handed a fixed stretch of
 * narration per assembly and works the interval out backwards so the placement fills it. Those are
 * genuinely different jobs, but they are the same shot, and two copies of "the same shot" drift
 * within a week.
 *
 * A block that carries a filter is dwelt on rather than passed over, and its filter is opened
 * inside the dwell: a builder puts the funnel down and sets it there, in one motion, rather than
 * walking the finished plant a second time.
 */

import { curveClear, placementShots } from './frame-parts.mjs';

/** Whole intervals, because the camera's keyframes are laid out one per interval. */
export const FILTER_DWELL = 8;

/** How many intervals an assembly occupies, filter dwells included. */
export function unitsFor(blocks, filterAt) {
  return blocks.reduce((n, b) => n + (filterAt.has(b.join(',')) ? FILTER_DWELL : 1), 0);
}

const describeFilter = (f) => `${f.kind === 'item' ? 'holds' : f.kind}: ${f.items.join(', ')}`;

/**
 * @param blocks     positions of this assembly, in the order the director will place them
 * @param placed     the world as it stands; grown by this call as the assembly goes up
 * @param noStanding everywhere the camera may not be — the finished build, plus where water reaches
 * @returns {{cues, endsAt, span, runs, lastPose}}
 */
export function followCues({
  name, what, blocks, placed, noStanding, origin, filterAt,
  msPerBlock, glideShare, startAt,
}) {
  const cues = [];
  const shots = placementShots(blocks, placed, origin, { neverStand: noStanding });
  const settleMs = Math.round(msPerBlock * (1 - glideShare));

  // Weights first: everything is one interval except the blocks that carry a filter. The offsets
  // are then the same arithmetic the director does, so a showFilter cue written here lands inside
  // the dwell rather than next to it.
  const weights = blocks.map((b) => (filterAt.has(b.join(',')) ? FILTER_DWELL : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const leading = total - weights[weights.length - 1];
  const span = msPerBlock * leading;
  const offsets = [];
  let running = 0;
  for (const w of weights) {
    offsets.push(Math.round(span * (running / leading)));
    running += w;
  }

  // One place cue for the whole assembly even though the camera moves inside it. Splitting the
  // placement to match would split the settle step with it, and the settle is what makes a belt
  // survive being laid one segment at a time — a Create belt with no neighbours yet is not a valid
  // belt and removes itself.
  const pace = { default: 1 };
  blocks.forEach((b, i) => {
    if (weights[i] !== 1) pace[b.join(',')] = weights[i];
  });
  cues.push({ type: 'place', atMs: startAt, blocks: { part: name }, spanMs: span, pace, _what: what });

  // The filter, opened where it belongs: on the funnel that was just put down, with the camera
  // already looking at it. Closed again in time for the next block's item to reach the hand.
  blocks.forEach((b, i) => {
    const f = filterAt.get(b.join(','));
    if (!f) return;
    cues.push({ type: 'showFilter', atMs: startAt + offsets[i] + 400, pos: b, _what: describeFilter(f) });
    cues.push({ type: 'screen', atMs: startAt + offsets[i] + (FILTER_DWELL - 1) * msPerBlock - 100,
                action: 'close' });
  });

  // One keyframe per interval, not one per block: a block the cue dwells on gets its pose repeated
  // so the camera holds there while the filter is open, and every keyframe still falls on a whole
  // interval of the linear cue.
  const poses = [];
  const firstKeyframe = [];
  shots.forEach((s, i) => {
    firstKeyframe.push(poses.length);
    const pose = { pos: s.pos, yaw: s.aim.yaw, pitch: s.aim.pitch };
    for (let k = 0; k < weights[i]; k++) poses.push(pose);
  });

  // One cue per unbroken run, not one per block. A cue per block means the camera eases in and out
  // twenty times a minute — it arrives, stops dead, and lurches off again, which is exactly what a
  // glide is not. A run also has to end where the curve through it would bow into something:
  // Catmull-Rom passes through every keyframe and bulges outside the box they span, which is how a
  // shot that clears every waypoint still clips a wall halfway along.
  const runs = [];
  shots.forEach((s, i) => {
    const open = runs.length ? runs[runs.length - 1] : null;
    const bows = open && !curveClear(
        poses.slice(firstKeyframe[open.from], firstKeyframe[i] + 1), noStanding);
    if (i === 0 || s.cut || bows) runs.push({ from: i, to: i });
    else open.to = i;
  });

  for (const run of runs) {
    // The camera reaches each standpoint a beat before its block does, so the shot is settled and
    // pointed at the spot when it appears rather than still swinging towards it.
    const at = Math.max(0, startAt + offsets[run.from] - settleMs);
    const frames = poses.slice(firstKeyframe[run.from], firstKeyframe[run.to] + weights[run.to]);
    if (frames.length < 2) {
      cues.push({ type: 'camera', atMs: at, durationMs: 1,
                  _what: `${name} — block ${run.from + 1}, cut`, keyframes: [frames[0], frames[0]] });
      continue;
    }
    cues.push({
      type: 'camera',
      atMs: at,
      durationMs: (frames.length - 1) * msPerBlock,
      // Linear, so keyframe three of seven really is three sevenths of the way through and the
      // camera is where it should be when the block it is watching for turns up.
      ease: 'linear',
      _what: `${name} — blocks ${run.from + 1}-${run.to + 1}`,
      keyframes: frames,
    });
  }

  return { cues, span, endsAt: startAt + span, runs, lastPose: poses[poses.length - 1] };
}
