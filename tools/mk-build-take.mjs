/**
 * Writes the silent build take: the plant going up one assembly at a time, then the switch.
 *
 *   node tools/mk-build-take.mjs                          > script/ore-plant-build-follow.json
 *   node tools/mk-build-take.mjs --style arc --locked-except '' > script/ore-plant-build.json
 *   node tools/mk-build-take.mjs --ms-per-block 200        > script/ore-plant-build-follow.json
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
// `locked` was what this was called before the camera was allowed to glide between blocks.
const DEFAULT_STYLE = (flag('style', 'follow') === 'locked' ? 'follow' : flag('style', 'follow'));
// Which assemblies do *not* get the default style. Comma-separated, or empty for none.
const EXCEPT = new Set((flag('locked-except', 'shell') || '').split(',').filter(Boolean));
const MS_PER_BLOCK = Number(flag('ms-per-block', 300));
const styleOf = (name) => (EXCEPT.has(name) ? (DEFAULT_STYLE === 'follow' ? 'arc' : 'follow') : DEFAULT_STYLE);
// How much of a block's interval is spent gliding to the next standpoint. The rest is hold: a
// beat on the block just placed, and a beat sitting still before the next one appears — which is
// what makes it read as somebody watching rather than as a camera on rails.
const GLIDE_SHARE = 0.62;

const ORIGIN = [0, -61, 0];
const groups = JSON.parse(await readFile('schematics/ore_plant.groups.json', 'utf8'));
const occupied = occupancy(groups, ORIGIN);
// Everywhere the camera may not stand: what the build occupies, plus wherever the water in it will
// have flowed to. The schematic only carries the sources.
const wet = waterReach(groups, ORIGIN);
const noStanding = new Set([...occupied, ...wet]);

// Bearing is where the camera stands, measured the way Minecraft measures yaw: 0 is south, 90 is
// west. Chosen so consecutive shots do not repeat an angle, and so the camera is on the open side
// of each assembly rather than behind the wall it is bolted to. Lift is for the parts no compass
// point helps: the sorter and the vault wall sit under the display boards and cannot be read from
// anywhere at eye level.
const SHOTS = {
  shell:      { bearing: 180, lift: 0, what: 'floor and the walls things hang on' },
  boiler:     { bearing: 45,  lift: 0, what: 'tanks, magma, engines, pumps, wheels' },
  drive:      { bearing: 200, lift: 0, what: 'chain drives, gearboxes, the speed controller' },
  dock:       { bearing: 120, lift: 0, what: 'belt, chutes, the interface the train unloads through' },
  crushing:   { bearing: 60,  lift: 0, what: 'two wheels, the controller, the belt loop' },
  washing:    { bearing: 60,  lift: 3, what: 'fan, leaf, water wheel, and the clay pair' },
  sorting:    { bearing: 210, lift: 3, what: 'six belts, six funnels' },
  compacting: { bearing: 45,  lift: 0, what: 'three basins, three presses' },
  storage:    { bearing: 60,  lift: 3, what: '27 vaults, 12 chests' },
  readout:    { bearing: 330, lift: 0, what: 'observers, links, sixteen boards' },
};

/**
 * The blocks nobody is watching go down: the floor, the walls it is lit and decorated with, and
 * the vault bank, which is twenty-seven identical boxes in a row. Everything else in this machine
 * is a component that does something, and those are what the shot is for.
 */
const BULK = [
  'minecraft:stone',
  'minecraft:deepslate',
  'minecraft:deepslate_bricks',
  'minecraft:cracked_deepslate_bricks',
  'minecraft:deepslate_brick_stairs',
  'minecraft:smooth_stone',
  'minecraft:cobblestone',
  'minecraft:cobbled_deepslate',
  'minecraft:infested_stone',
  'minecraft:iron_ore',
  'minecraft:deepslate_iron_ore',
  'minecraft:redstone_ore',
  'minecraft:glowstone',
  'minecraft:spruce_trapdoor',
  'minecraft:water',
  'create:cut_deepslate_bricks',
  'create:item_vault',
];
// Six to one. Not a speed but a share: a cue still ends when it said it would, and this decides
// how its time is split between the stone and the machinery standing on it.
const PACE = Object.fromEntries([['default', 6], ...BULK.map((id) => [id, 1])]);

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
  return Math.min(12000, Math.max(3000, Math.round((bulk * 12 + parts * 240) / 500) * 500));
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
let at = 500;
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
  const span = blocks.length * MS_PER_BLOCK;
  const settleMs = Math.round(MS_PER_BLOCK * (1 - GLIDE_SHARE));
  cues.push({ type: 'place', atMs: at, blocks: { part: name }, staggerMs: MS_PER_BLOCK,
              _what: shot.what });

  // One cue per unbroken run, not one per block. A cue per block means the camera eases in and
  // eases out twenty times a minute — it arrives, stops dead, and lurches off again, which is
  // exactly what a glide is not. A single cue whose keyframes are the standpoints, walked at a
  // constant rate, is one continuous move that happens to pass through each of them on time.
  const poses = shots.map((s) => ({ pos: s.pos, yaw: s.aim.yaw, pitch: s.aim.pitch }));
  const runs = [];
  shots.forEach((s, i) => {
    // A run also has to end where the curve through it would bow into something. Checking the
    // straight hops between standpoints is not enough once a run has more than two of them:
    // Catmull-Rom passes through every keyframe and bulges outside the box they span, which is
    // how a shot that clears every waypoint still clips a wall halfway along.
    const open = runs.length ? runs[runs.length - 1] : null;
    const bows = open && !curveClear(poses.slice(open.from, i + 1), noStanding);
    if (i === 0 || s.cut || bows) runs.push({ from: i, count: 1 });
    else open.count++;
  });

  for (const run of runs) {
    // The camera reaches each standpoint a beat before its block does, so the shot is settled and
    // pointed at the spot when it appears rather than still swinging towards it.
    const startAt = Math.max(0, at + run.from * MS_PER_BLOCK - settleMs);
    if (run.count === 1) {
      const pose = poses[run.from];
      cues.push({ type: 'camera', atMs: startAt, durationMs: 1,
                  _what: `${name} — block ${run.from + 1}, cut`, keyframes: [pose, pose] });
      continue;
    }
    cues.push({
      type: 'camera',
      atMs: startAt,
      durationMs: (run.count - 1) * MS_PER_BLOCK,
      // Linear, so keyframe three of seven really is three sevenths of the way through and the
      // camera is where it should be when the block it is watching for turns up.
      ease: 'linear',
      _what: `${name} — blocks ${run.from + 1}-${run.from + run.count}`,
      keyframes: poses.slice(run.from, run.from + run.count),
    });
  }
  const previous = poses[poses.length - 1];

  // Hold on the finished assembly for a moment rather than cutting away from it.
  cues.push({ type: 'camera', atMs: at + span, durationMs: 3200,
              _what: `${name} — finished`, keyframes: [previous, previous] });
  cues.push({ type: 'marker', atMs: at + span + 1200, label: name });
  report.push(`${name.padEnd(11)} follow  ${String(blocks.length).padStart(3)} blocks  ${span} ms  `
    + `${runs.length} shot${runs.length === 1 ? '' : 's'}`);
  at += span + 4200;
}

// The lever is on one side of a block and a redstone torch is on the other. Off, the torch burns,
// the wire carries fifteen, the clutch is powered and a powered clutch is a disengaged one — so the
// water wheels turn nothing, the pumps do not pump and the boiler stays dry. Throwing it puts
// current into the block, the torch goes out, and everything after it comes alive at once.
cues.push({ type: 'use', atMs: at, pos: [7, 5, 19], _what: 'the boiler switch, pulled' });

// And only then the kinetic blocks, bare. setBlock returns early when the state it is handed is
// the state already there, so re-asserting the build does nothing for a block the build got right
// — and a cloned water wheel is right in every way except which kinetic network it believes it is
// part of. It has to go to air and come back, with none of its saved data, to go looking again.
const KINETIC = ['create:andesite_encased_cogwheel', 'create:andesite_encased_large_cogwheel',
  'create:andesite_encased_shaft', 'create:clutch', 'create:crushing_wheel',
  'create:crushing_wheel_controller', 'create:encased_chain_drive', 'create:encased_fan',
  'create:gearbox', 'create:large_cogwheel', 'create:mechanical_press', 'create:mechanical_pump',
  'create:powered_shaft', 'create:shaft', 'create:steam_engine', 'create:stressometer',
  'create:water_wheel'];
cues.push({ type: 'reseat', atMs: at + 2500, ofType: KINETIC,
            _what: 'every pure kinetic block, bare, so it finds the network it is actually on' });

const readout = bounds(palette.readout);
cues.push({ type: 'camera', atMs: at + 3500, durationMs: 12000, _what: 'the wall, once it is running',
            keyframes: moveFor(readout.lo, readout.size, ORIGIN, SHOTS.readout.bearing, occupied, 0) });
cues.push({ type: 'marker', atMs: at + 16000, label: 'running' });

process.stdout.write(JSON.stringify({
  take: DEFAULT_STYLE === 'follow' ? 'ore-plant-build-follow' : 'ore-plant-build',
  _what: `A silent run-through, ${DEFAULT_STYLE} style`
       + (EXCEPT.size ? ` except ${[...EXCEPT].join(', ')}` : '')
       + '. Then the switch is pulled, the kinetic blocks are reseated bare, and the camera stays '
       + 'on the wall. Regenerated by tools/mk-build-take.mjs — edit that, not this.',
  schematic: 'ore_plant.nbt',
  parts: 'ore_plant.groups.json',
  origin: ORIGIN,
  clearStage: true,
  presentation: { heldItem: true, swing: true, sound: true, particles: true },
  cues,
}, null, 2) + '\n');

for (const line of report) process.stderr.write(line + '\n');
process.stderr.write(`total ${Math.round((at + 16000) / 1000)} s\n`);
