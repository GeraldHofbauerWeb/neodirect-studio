/**
 * Writes the live-flow take: ore into the dock chest, both chute filters held up, then spectator
 * and a camera that follows the material through crusher, washer and press.
 *
 *   node tools/mk-flow-take.mjs > script/ore-plant-flow.json
 *
 * Separate from the narrated storyboard on purpose. This one has no voice under it — it is the
 * shot list for what the plant does once it is fed, and the framing is argued with by watching it
 * rather than by reading a bounding box. The stations are named by the blocks that make them,
 * not by part name: a part is everything an assembly owns, and half of that is housing the shot
 * does not want in frame.
 */

import { readFile } from 'node:fs/promises';
import { bounds, moveFor, occupancy, visibility, insideMove, vantages } from './frame-parts.mjs';
import { aim } from './aim.mjs';

const ORIGIN = [0, -61, 0];
const groups = JSON.parse(await readFile('schematics/ore_plant.groups.json', 'utf8'));
const occupied = occupancy(groups, ORIGIN);

// Bearing is where the camera ends up relative to what it looks at, so bearing 45 — southeast —
// is the northwest-facing shot the rest of this episode uses. A move arcs 28 degrees on its way
// in, and it is the last frame of a shot that has to be the right one, so the arc is subtracted
// here rather than left for whoever reads the numbers to work out. The crusher and the washer do not
// get one: from the southeast both sit behind the vault wall, and every angle that reads them is
// from the east. These are the bearings the build take already films them from, moved closer.
const NORTHWEST = 45;
const ARC = 28;

const STATIONS = [
  {
    name: 'dock',
    what: 'the chest the train unloads into, and the two chutes under it',
    blocks: [[18, 4, 10], [19, 4, 10], [18, 3, 10], [19, 3, 10], [18, 2, 10], [17, 2, 10]],
    bearing: 126,
  },
  {
    name: 'crusher',
    what: 'two wheels, the controller between them, and the belt that carries the crushed ore out',
    // Shot from inside. There is no outside for this one: the crusher sits in the middle of the
    // plant with the vault wall on its south side, and every exterior bearing reads it as a grey
    // smudge behind a chest — which is exactly what the first cut of this shot looked like, and
    // near enough identical to the washer's, three blocks along. The camera stands in the gap
    // between the feed belt and the output belt, two blocks off the wheels.
    blocks: [[9, 5, 7], [10, 5, 7], [11, 5, 7]],
    inside: { near: 3.8, far: 7 },
    // Aimed a little lower and wider than it stands, so the belt the crushed ore leaves on is in
    // frame rather than just below it.
    lookAt: [[9, 5, 7], [10, 5, 7], [11, 5, 7], [10, 4, 6], [10, 4, 7]],
  },
  {
    name: 'washer',
    what: 'the fan, the waterlogged leaf in front of it, and what comes off the belt below',
    blocks: [[13, 5, 2], [13, 5, 3], [13, 5, 4], [13, 5, 5], [12, 4, 5], [12, 4, 6]],
    bearing: 78,
  },
  {
    name: 'press',
    what: 'three basins with a press over each, and the funnels that feed them off the lanes',
    blocks: [[11, 5, 13], [12, 5, 13], [13, 5, 13], [11, 7, 13], [12, 7, 13], [13, 7, 13],
             [11, 5, 12], [12, 5, 12], [13, 5, 12], [12, 4, 12], [12, 4, 14]],
    bearing: NORTHWEST,
  },
];

// No automatic bearing search here. The score behind one counts blocks a ray reaches and is a
// good detector of "there is a wall in the way" and a poor judge of a shot — it rotated all four
// of these off angles that read perfectly. It is still worth printing: a number that collapses
// after the schematic is re-cut is the wall having moved.
function shotFor(station) {
  if (station.inside) {
    const world = (p) => [p[0] + ORIGIN[0], p[1] + ORIGIN[1], p[2] + ORIGIN[2]];
    const move = insideMove(station.blocks.map(world), occupied,
        { ...station.inside, minY: ORIGIN[1] + 1, lookAt: (station.lookAt ?? station.blocks).map(world) });
    const targets = (station.lookAt ?? station.blocks).map(world);
    return { keyframes: move.keyframes, seen: visibility(move.end.pos, targets, occupied) };
  }
  const { lo, size } = bounds(station.blocks);
  const keyframes = moveFor(lo, size, ORIGIN, station.bearing - ARC, occupied, station.lift ?? 0);
  const targets = station.blocks.map((p) => [p[0] + ORIGIN[0], p[1] + ORIGIN[1], p[2] + ORIGIN[2]]);
  const seen = visibility(keyframes[keyframes.length - 1].pos, targets, occupied);
  return { keyframes, seen };
}

// Ore, raw ore and the spoil that comes up the shaft with it. The spoil is the point of the two
// chutes: half of what a mining train brings back is stone, and the machine has to be told which
// half before anything else can happen.
const LOAD = [
  { id: 'minecraft:raw_iron', count: 64 },
  { id: 'minecraft:raw_gold', count: 64 },
  { id: 'minecraft:raw_copper', count: 64 },
  { id: 'create:raw_zinc', count: 64 },
  { id: 'minecraft:iron_ore', count: 64 },
  { id: 'minecraft:deepslate_iron_ore', count: 64 },
  { id: 'minecraft:gold_ore', count: 64 },
  { id: 'minecraft:copper_ore', count: 64 },
  { id: 'create:zinc_ore', count: 64 },
  { id: 'minecraft:cobblestone', count: 64 },
  { id: 'minecraft:cobbled_deepslate', count: 64 },
  { id: 'minecraft:gravel', count: 64 },
  { id: 'minecraft:flint', count: 64 },
  { id: 'minecraft:netherrack', count: 64 },
];


/**
 * Every configured filter in the plant, in the order material meets them.
 *
 * Twenty-two of them, and the whole argument of the episode is that no two are set the same way —
 * which is not something anybody takes on trust from a wide shot of a funnel row. So each one is
 * cut to and opened on its own, before a single item goes in. The order is the machine's, not the
 * block array's, which is why it is written out rather than read off the schematic.
 */
const FILTERS = [
  { station: 'the dock', pos: [19, 3, 10], what: 'smart chute — allow: the eight stone types' },
  { station: 'the dock', pos: [18, 3, 10], what: 'smart chute — deny: the same eight' },
  { station: 'the dock', pos: [19, 5, 10], what: 'smart chute — deny: rail, so the train keeps its own track' },

  { station: 'the crusher', pos: [13, 5, 4], what: 'brass funnel — allow: crushed iron, gold, copper, zinc' },
  { station: 'the crusher', pos: [13, 5, 5], what: 'brass funnel — deny: the same four' },
  { station: 'the crusher', pos: [12, 5, 5], what: 'belt funnel — allow: the eight stone types again' },
  { station: 'the crusher', pos: [10, 5, 8], what: 'belt funnel — allow: what comes back out' },
  { station: 'the crusher', pos: [10, 3, 6], what: 'brass funnel — allow: the crushed four, a floor down' },

  { station: 'the washer', pos: [13, 4, 6], what: 'brass funnel — allow: clay' },
  { station: 'the washer', pos: [13, 5, 7], what: 'belt funnel — deny: clay' },

  { station: 'the sorter', pos: [8, 5, 11], what: 'lane 1 — experience nuggets' },
  { station: 'the sorter', pos: [9, 5, 11], what: 'lane 2 — lapis, emerald, diamond, ore and gem alike' },
  { station: 'the sorter', pos: [10, 5, 11], what: 'lane 3 — gunpowder and quartz' },
  { station: 'the sorter', pos: [11, 5, 11], what: 'lane 4 — redstone and coal' },
  { station: 'the sorter', pos: [12, 5, 11], what: 'lane 5 — copper and zinc' },
  { station: 'the sorter', pos: [13, 5, 11], what: 'lane 6 — iron and gold' },

  { station: 'the presses', pos: [11, 5, 13], what: 'basin — redstone and coal' },
  { station: 'the presses', pos: [12, 5, 13], what: 'basin — copper and zinc' },
  { station: 'the presses', pos: [13, 5, 13], what: 'basin — iron and gold' },
  { station: 'the presses', pos: [11, 5, 14], what: 'output funnel — the finished block only' },
  { station: 'the presses', pos: [12, 5, 14], what: 'output funnel — the finished block only' },
  { station: 'the presses', pos: [13, 5, 14], what: 'output funnel — the finished block only' },
];

/**
 * A cut, not a move: twenty-two slow push-ins would take four minutes and read no better.
 *
 * Nearest-and-visible is not enough to choose by. The closest air to a funnel buried in a plant is
 * usually the block directly above it, and a shot looking straight down on a funnel tells a viewer
 * nothing about which funnel it is — the first cut of this beat had nine of the twenty-two at a
 * pitch of ninety. So a steep angle is paid for, and so is standing too close or too far to read
 * the thing.
 */
const IDEAL_DISTANCE = 3.2;

function lookAtFilter(pos) {
  const world = [pos[0] + ORIGIN[0], pos[1] + ORIGIN[1], pos[2] + ORIGIN[2]];
  const centre = [world[0] + 0.5, world[1] + 0.5, world[2] + 0.5];
  const found = vantages([world], occupied, { near: 1.8, far: 7, minY: ORIGIN[1] + 1 });
  if (!found.vantages.length) throw new Error('nowhere to see the filter at ' + pos.join(','));

  const scored = found.vantages.map((v) => {
    const { yaw, pitch } = aim(v.pos, centre);
    const steep = Math.max(0, Math.abs(pitch) - 30) / 60;
    const off = Math.abs(v.distance - IDEAL_DISTANCE) / 6;
    return { ...v, yaw, pitch, score: v.seen - steep * 0.7 - off * 0.3 };
  });
  scored.sort((a, b) => b.score - a.score);

  const from = scored[0];
  const frame = { pos: from.pos.map((n) => Math.round(n * 10) / 10), yaw: from.yaw, pitch: from.pitch };
  return { keyframes: [frame, frame], seen: from.seen, pitch: from.pitch, distance: from.distance };
}

const cues = [];
const shots = {};
for (const station of STATIONS) shots[station.name] = shotFor(station);
const last = (k) => [k[k.length - 1], k[k.length - 1]];

// One filter every three seconds: a beat to see which block it belongs to, two to read the list.
const FILTER_CUT = 3000;
let at = 0;
let station = null;
let steepest = 0;
for (const filter of FILTERS) {
  if (filter.station !== station) {
    station = filter.station;
    cues.push({ type: 'marker', atMs: at, label: 'filters — ' + station });
  }
  const shot = lookAtFilter(filter.pos);
  steepest = Math.max(steepest, Math.abs(shot.pitch));
  cues.push({ type: 'camera', atMs: at, durationMs: FILTER_CUT, _what: filter.what,
              keyframes: shot.keyframes });
  cues.push({ type: 'showFilter', atMs: at + 700, pos: filter.pos, _what: filter.what });
  cues.push({ type: 'screen', atMs: at + FILTER_CUT - 400, action: 'close' });
  at += FILTER_CUT;
}

// Only now the ore. Everything above decides where it ends up.
at += 1000;
const dock = shots.dock;
cues.push({ type: 'marker', atMs: at, label: 'the dock' });
cues.push({ type: 'camera', atMs: at, durationMs: 5500, _what: 'dock — ' + STATIONS[0].what,
            keyframes: dock.keyframes });
cues.push({ type: 'fill', atMs: at + 1500, pos: [18, 4, 10], items: LOAD,
            _what: 'a train-load: ore, raw ore, and the stone that came up with it' });
cues.push({ type: 'camera', atMs: at + 5500, durationMs: 4000, _what: 'dock — the chutes emptying it',
            keyframes: last(dock.keyframes) });

// Out of creative for the rest of it. Nothing after this places a block or opens a screen, and
// spectator takes the hand and the hotbar out of every remaining frame.
cues.push({ type: 'gameMode', atMs: at + 9000, mode: 'spectator' });
at += 10000;

for (const stationDef of STATIONS.slice(1)) {
  const station = stationDef;
  const shot = shots[station.name];
  cues.push({ type: 'marker', atMs: at, label: station.name });
  cues.push({ type: 'camera', atMs: at, durationMs: 5000, _what: station.name + ' — ' + station.what,
              keyframes: shot.keyframes });
  cues.push({ type: 'camera', atMs: at + 5000, durationMs: 7000,
              _what: station.name + ' — held while the material comes through',
              keyframes: last(shot.keyframes) });
  at += 12500;
}

const whole = bounds(Object.values(groups.parts).flat().filter((p) => p[1] >= 2));
const wide = moveFor(whole.lo, whole.size, ORIGIN, NORTHWEST - ARC, occupied, 4);
cues.push({ type: 'marker', atMs: at, label: 'the whole line' });
cues.push({ type: 'camera', atMs: at, durationMs: 10000, _what: 'the plant working, end to end',
            keyframes: wide });

const timeline = {
  take: 'ore-plant-flow',
  _what: 'Feed the dock, show the two chutes that decide what is ore, then follow a load through '
       + 'the machine in spectator. Nothing is built here — the plant is already standing.',
  schematic: 'ore_plant.nbt',
  parts: 'ore_plant.groups.json',
  origin: ORIGIN,
  clearStage: false,
  presentation: { heldItem: false, swing: false, sound: true, particles: true },
  cues,
};

process.stdout.write(JSON.stringify(timeline, null, 2) + '\n');
process.stderr.write(`${FILTERS.length} filters, steepest camera ${Math.round(steepest)} degrees\n`);
for (const [name, s] of Object.entries(shots)) {
  process.stderr.write(`${name.padEnd(8)} ends at ${s.keyframes[2].pos.join(', ')}  `
    + `yaw ${s.keyframes[2].yaw}  visible ${Math.round(s.seen * 100)}%\n`);
}
