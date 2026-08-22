/**
 * Writes the silent build take: the plant going up one assembly at a time, then the switch.
 *
 *   node tools/mk-build-take.mjs                          > script/ore-plant-build-follow.json
 *   node tools/mk-build-take.mjs --style arc --locked-except '' > script/ore-plant-build.json
 *   node tools/mk-build-take.mjs --ms-per-block 200        > script/ore-plant-build-follow.json
 *   node tools/mk-build-take.mjs script/other.shots.json   > script/other-build.json
 *
 * The shot list is a document — script/ore-plant.shots.json by default. Which assembly is filmed
 * which way, from what bearing, at what pace and how the plant is switched on all live there,
 * because they are decisions about the episode rather than facts about the generator, and the
 * studio has to be able to change them without editing this file.
 *
 * No narration under it. This is the run-through that proves the machine can be built from the
 * schematic and will run when it is finished, and it is the thing to watch when a shot needs
 * re-framing. The narrated version comes from script/ore-plant.storyboard.json, which fits the
 * same placements to the measured beats.
 *
 * Two styles, and the choice is per assembly rather than per take, because the answer differs
 * inside one build:
 *
 *   arc     the camera swings past while the blocks appear, and the time inside a cue is shared
 *           out by `pace` — a glance for each floor slab, a beat for each component. Right for
 *           the housing, where nobody is watching an individual stone go down.
 *
 *   follow  the camera is close, pointed at the exact face the next block goes against, and it
 *           drifts from one to the next rather than panning across the room. Every block gets the
 *           same interval and its own moment. Right for the machinery, which is the part anybody
 *           is actually trying to copy. (`locked` is accepted as a name for it too.)
 *
 * Default: everything followed except the shell, so the floor still goes down quickly.
 */

import { readFile } from 'node:fs/promises';
import { bounds, curveClear, moveFor, occupancy, placementShots, waterReach } from './frame-parts.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};
const SHOTS_PATH = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)
  ?? 'script/ore-plant.shots.json';
const list = JSON.parse(await readFile(SHOTS_PATH, 'utf8'));
// `locked` was what this was called before the camera was allowed to glide between blocks.
const asked = flag('style', list.defaults.style);
const DEFAULT_STYLE = asked === 'locked' ? 'follow' : asked;
// Which assemblies do *not* get the default style. Comma-separated, or empty for none.
const EXCEPT = new Set((flag('locked-except', (list.defaults.except ?? []).join(',')) || '').split(',').filter(Boolean));
const MS_PER_BLOCK = Number(flag('ms-per-block', list.defaults.msPerBlock));
// A shot may name its own style, which is how the studio expresses "this assembly, close up"
// without a flag. Anything that does not falls back to the default, flipped for the exceptions.
const styleOf = (name) => SHOTS[name].style
  ?? (EXCEPT.has(name) ? (DEFAULT_STYLE === 'follow' ? 'arc' : 'follow') : DEFAULT_STYLE);
// How much of a block's interval is spent gliding to the next standpoint. The rest is hold: a
// beat on the block just placed, and a beat sitting still before the next one appears — which is
// what makes it read as somebody watching rather than as a camera on rails.
const GLIDE_SHARE = list.defaults.glideShare;

const ORIGIN = list.origin;
const groups = JSON.parse(await readFile(`schematics/${list.parts}`, 'utf8'));
const occupied = occupancy(groups, ORIGIN);
// Everywhere the camera may not stand: what the build occupies, plus wherever the water in it will
// have flowed to. The schematic only carries the sources.
const wet = waterReach(groups, ORIGIN);
const noStanding = new Set([...occupied, ...wet]);

// A block with a filter is not placed and left. Somebody puts the funnel down, opens it and sets
// what it lets through, in one motion — nobody makes a second pass over the whole plant afterwards
// setting filters. So the cue dwells on those blocks instead of moving straight on, and the filter
// is opened inside the dwell. Whole intervals, because the camera's keyframes are laid out one per
// interval and a fractional dwell would put them out of step with the placements.
const FILTER_DWELL = 8;
const filterAt = new Map((groups.filters ?? []).map((f) => [f.pos.join(','), f]));
const label = (f) => `${f.kind === 'item' ? 'holds' : f.kind}: ${f.items.join(', ')}`;

// Where each assembly is filmed from, in the order it goes up — see script/ore-plant.shots.json,
// which carries the reasoning along with the numbers.
const SHOTS = Object.fromEntries(list.shots.map((shot) => [shot.part, shot]));

/** The blocks nobody is watching go down. Named in the shot list, weighed against the rest here. */
const BULK = list.bulk;
const PACE = Object.fromEntries([['default', list.paceDefault], ...BULK.map((id) => [id, list.paceBulk])]);

const palette = await (async () => {
  const positions = {};
  for (const [name, blocks] of Object.entries(groups.parts)) positions[name] = blocks;
  return positions;
})();

/**
 * How long an assembly takes to go up: a glance for each bulk block, a beat for each component.
 * Derived rather than typed, so a re-cut schematic re-times itself instead of quietly speeding up.
 */
function spanFor(name) {
  const ids = groups.ids?.[name];
  const blocks = palette[name];
  let bulk = 0;
  let parts = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (ids && BULK.includes(ids[i])) bulk++;
    else parts++;
  }
  if (!ids) { bulk = 0; parts = blocks.length; }
  const t = list.timing;
  return Math.min(t.maxMs, Math.max(t.minMs,
    Math.round((bulk * t.bulkMs + parts * t.partMs) / t.roundTo) * t.roundTo));
}

/** How long an assembly occupies the timeline, and what it costs to say so. */
const report = [];

// The world as it stands, grown assembly by assembly. The follow style casts its rays against
// this rather than against the finished plant: a block that ends up walled in is in plain sight at
// the moment it goes down, and that is the only moment a camera has to see it.
const placed = new Set();
const remember = (name) => {
  for (const p of palette[name]) placed.add(`${p[0] + ORIGIN[0]},${p[1] + ORIGIN[1]},${p[2] + ORIGIN[2]}`);
};

const cues = [];
let at = list.timing.startMs;
for (const [name, shot] of Object.entries(SHOTS)) {
  const blocks = palette[name];

  if (styleOf(name) === 'arc') {
    const { lo, size } = bounds(blocks);
    const span = spanFor(name);
    cues.push({ type: 'camera', atMs: at, durationMs: span + 3000, _what: name,
                keyframes: moveFor(lo, size, ORIGIN, shot.bearing, occupied, shot.lift) });
    cues.push({ type: 'place', atMs: at + 400, blocks: { part: name }, spanMs: span,
                pace: PACE, _what: shot.what });
    cues.push({ type: 'marker', atMs: at + span + 1200, label: name });
    report.push(`${name.padEnd(11)} arc     ${String(blocks.length).padStart(3)} blocks  ${span} ms`);
    remember(name);
    at += span + 4200;
    continue;
  }

  // One place cue for the whole assembly even though the camera moves inside it. Splitting the
  // placement to match would split the settle step with it, and the settle is what makes a belt
  // survive being laid one segment at a time — a Create belt with no neighbours yet is not a
  // valid belt and removes itself.
  const shots = placementShots(blocks, placed, ORIGIN, { neverStand: noStanding });
  const settleMs = Math.round(MS_PER_BLOCK * (1 - GLIDE_SHARE));

  // Weights first: everything is one interval except the blocks that carry a filter. The offsets
  // are then the same arithmetic the director does, so a showFilter cue written here lands inside
  // the dwell rather than next to it.
  const weights = blocks.map((b) => (filterAt.has(b.join(',')) ? FILTER_DWELL : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const leading = total - weights[weights.length - 1];
  const span = MS_PER_BLOCK * leading;
  const offsets = [];
  let running = 0;
  for (const w of weights) {
    offsets.push(Math.round(span * (running / leading)));
    running += w;
  }

  const pace = { default: 1 };
  blocks.forEach((b, i) => {
    if (weights[i] !== 1) pace[b.join(',')] = weights[i];
  });
  cues.push({ type: 'place', atMs: at, blocks: { part: name }, spanMs: span, pace,
              _what: shot.what });

  // The filter, opened where it belongs: on the funnel that was just put down, with the camera
  // already looking at it. Closed again in time for the next block's item to reach the hand.
  blocks.forEach((b, i) => {
    const f = filterAt.get(b.join(','));
    if (!f) return;
    cues.push({ type: 'showFilter', atMs: at + offsets[i] + 400, pos: b, _what: label(f) });
    cues.push({ type: 'screen', atMs: at + offsets[i] + (FILTER_DWELL - 1) * MS_PER_BLOCK - 100,
                action: 'close' });
  });

  // One cue per unbroken run, not one per block. A cue per block means the camera eases in and
  // eases out twenty times a minute — it arrives, stops dead, and lurches off again, which is
  // exactly what a glide is not. A single cue whose keyframes are the standpoints, walked at a
  // constant rate, is one continuous move that happens to pass through each of them on time.
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
  const runs = [];
  shots.forEach((s, i) => {
    // A run also has to end where the curve through it would bow into something. Checking the
    // straight hops between standpoints is not enough once a run has more than two of them:
    // Catmull-Rom passes through every keyframe and bulges outside the box they span, which is
    // how a shot that clears every waypoint still clips a wall halfway along.
    const open = runs.length ? runs[runs.length - 1] : null;
    const bows = open && !curveClear(
        poses.slice(firstKeyframe[open.from], firstKeyframe[i] + 1), noStanding);
    if (i === 0 || s.cut || bows) runs.push({ from: i, to: i });
    else open.to = i;
  });

  for (const run of runs) {
    // The camera reaches each standpoint a beat before its block does, so the shot is settled and
    // pointed at the spot when it appears rather than still swinging towards it.
    const startAt = Math.max(0, at + offsets[run.from] - settleMs);
    const frames = poses.slice(firstKeyframe[run.from],
        firstKeyframe[run.to] + weights[run.to]);
    if (frames.length < 2) {
      cues.push({ type: 'camera', atMs: startAt, durationMs: 1,
                  _what: `${name} — block ${run.from + 1}, cut`, keyframes: [frames[0], frames[0]] });
      continue;
    }
    cues.push({
      type: 'camera',
      atMs: startAt,
      durationMs: (frames.length - 1) * MS_PER_BLOCK,
      // Linear, so keyframe three of seven really is three sevenths of the way through and the
      // camera is where it should be when the block it is watching for turns up.
      ease: 'linear',
      _what: `${name} — blocks ${run.from + 1}-${run.to + 1}`,
      keyframes: frames,
    });
  }
  const previous = poses[poses.length - 1];

  // Hold on the finished assembly for a moment rather than cutting away from it.
  cues.push({ type: 'camera', atMs: at + span, durationMs: 3200,
              _what: `${name} — finished`, keyframes: [previous, previous] });
  cues.push({ type: 'marker', atMs: at + span + 1200, label: name });
  report.push(`${name.padEnd(11)} follow  ${String(blocks.length).padStart(3)} blocks  ${span} ms  `
    + `${runs.length} shot${runs.length === 1 ? '' : 's'}`);
  at += span + list.timing.gapMs;
}

// The lever is on one side of a block and a redstone torch is on the other. Off, the torch burns,
// the wire carries fifteen, the clutch is powered and a powered clutch is a disengaged one — so the
// water wheels turn nothing, the pumps do not pump and the boiler stays dry. Throwing it puts
// current into the block, the torch goes out, and everything after it comes alive at once.
cues.push({ type: 'use', atMs: at, pos: list.finish.lever, _what: 'the boiler switch, pulled' });

// And only then the kinetic blocks, bare. setBlock returns early when the state it is handed is
// the state already there, so re-asserting the build does nothing for a block the build got right
// — and a cloned water wheel is right in every way except which kinetic network it believes it is
// part of. It has to go to air and come back, with none of its saved data, to go looking again.
const KINETIC = list.finish.reseat;
cues.push({ type: 'reseat', atMs: at + 2500, ofType: KINETIC,
            _what: 'every pure kinetic block, bare, so it finds the network it is actually on' });

const readout = bounds(palette[list.finish.holdPart]);
cues.push({ type: 'camera', atMs: at + 3500, durationMs: list.finish.holdMs, _what: 'the wall, once it is running',
            keyframes: moveFor(readout.lo, readout.size, ORIGIN, SHOTS[list.finish.holdPart].bearing, occupied, 0) });
cues.push({ type: 'marker', atMs: at + list.finish.tailMs, label: 'running' });

process.stdout.write(JSON.stringify({
  take: DEFAULT_STYLE === 'follow' ? 'ore-plant-build-follow' : 'ore-plant-build',
  _what: `A silent run-through, ${DEFAULT_STYLE} style`
       + (EXCEPT.size ? ` except ${[...EXCEPT].join(', ')}` : '')
       + '. Then the switch is pulled, the kinetic blocks are reseated bare, and the camera stays '
       + 'on the wall. Regenerated by tools/mk-build-take.mjs — edit that, not this.',
  schematic: list.schematic,
  parts: list.parts,
  origin: ORIGIN,
  clearStage: true,
  presentation: { heldItem: true, swing: true, sound: true, particles: true },
  cues,
}, null, 2) + '\n');

for (const line of report) process.stderr.write(line + '\n');
process.stderr.write(`total ${Math.round((at + list.finish.tailMs) / 1000)} s\n`);
