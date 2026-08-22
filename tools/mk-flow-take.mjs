/**
 * Writes the live-flow take: ore into the dock chest, then spectator
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
import { stationShot } from './station-shots.mjs';

// The stations, the filters and the load are a document — script/ore-plant.stations.json by
// default. They are decisions about the episode rather than facts about the generator, and the
// studio has to be able to change them without editing this file.
const LIST_PATH = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'script/ore-plant.stations.json';
const list = JSON.parse(await readFile(LIST_PATH, 'utf8'));
const ORIGIN = list.origin;
const groups = JSON.parse(await readFile(`schematics/${list.parts}`, 'utf8'));
const occupied = occupancy(groups, ORIGIN);

// Bearing is where the camera ends up relative to what it looks at, so bearing 45 — southeast —
// is the northwest-facing shot the rest of this episode uses. A move arcs 28 degrees on its way
// in, and it is the last frame of a shot that has to be the right one, so the arc is subtracted
// here rather than left for whoever reads the numbers to work out. The crusher and the washer do not
// get one: from the southeast both sit behind the vault wall, and every angle that reads them is
// from the east. These are the bearings the build take already films them from, moved closer.
const NORTHWEST = list.framing.northwest;
const ARC = list.framing.arc;

const STATIONS = list.stations;

// No automatic bearing search here. The score behind one counts blocks a ray reaches and is a
// good detector of "there is a wall in the way" and a poor judge of a shot — it rotated all four
// of these off angles that read perfectly. It is still worth printing: a number that collapses
// after the schematic is re-cut is the wall having moved.
const shotFor = (station) => stationShot(station, occupied, ORIGIN, list.framing);

// Ore, raw ore and the spoil that comes up the shaft with it. The spoil is the point of the two
// chutes: half of what a mining train brings back is stone, and the machine has to be told which
// half before anything else can happen.
const LOAD = list.load;


/**
 * Every configured filter in the plant, in the order material meets them.
 *
 * Twenty-two of them, and the whole argument of the episode is that no two are set the same way —
 * which is not something anybody takes on trust from a wide shot of a funnel row. So each one is
 * cut to and opened on its own, before a single item goes in. The order is the machine's, not the
 * block array's, which is why it is written out rather than read off the schematic.
 */
const FILTERS = list.filters ?? [];

/**
 * A cut, not a move: twenty-two slow push-ins would take four minutes and read no better.
 *
 * Nearest-and-visible is not enough to choose by. The closest air to a funnel buried in a plant is
 * usually the block directly above it, and a shot looking straight down on a funnel tells a viewer
 * nothing about which funnel it is — the first cut of this beat had nine of the twenty-two at a
 * pitch of ninety. So a steep angle is paid for, and so is standing too close or too far to read
 * the thing.
 */
const IDEAL_DISTANCE = list.framing.idealDistance;

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
const FILTER_CUT = list.framing.filterCutMs;
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
cues.push({ type: 'camera', atMs: at, durationMs: list.framing.dockHoldMs, _what: 'dock — ' + STATIONS[0].what,
            keyframes: dock.keyframes });
cues.push({ type: 'fill', atMs: at + 1500, pos: list.dock.fillPos, items: LOAD,
            _what: 'a train-load: ore, raw ore, and the stone that came up with it' });
cues.push({ type: 'camera', atMs: at + list.framing.dockHoldMs, durationMs: list.framing.dockDrainMs, _what: 'dock — the chutes emptying it',
            keyframes: last(dock.keyframes) });

// Out of creative for the rest of it. Nothing after this places a block or opens a screen, and
// spectator takes the hand and the hotbar out of every remaining frame.
cues.push({ type: 'gameMode', atMs: at + list.dock.spectatorAtMs, mode: 'spectator' });
at += 10000;

for (const stationDef of STATIONS.slice(1)) {
  const station = stationDef;
  const shot = shots[station.name];
  cues.push({ type: 'marker', atMs: at, label: station.name });
  cues.push({ type: 'camera', atMs: at, durationMs: list.framing.stationMoveMs, _what: station.name + ' — ' + station.what,
              keyframes: shot.keyframes });
  cues.push({ type: 'camera', atMs: at + list.framing.stationMoveMs, durationMs: list.framing.stationHoldMs,
              _what: station.name + ' — held while the material comes through',
              keyframes: last(shot.keyframes) });
  at += list.framing.stationGapMs;
}

const whole = bounds(Object.values(groups.parts).flat().filter((p) => p[1] >= 2));
const wide = moveFor(whole.lo, whole.size, ORIGIN, NORTHWEST - ARC, occupied, 4);
cues.push({ type: 'marker', atMs: at, label: 'the whole line' });
cues.push({ type: 'camera', atMs: at, durationMs: list.framing.wideMs, _what: 'the plant working, end to end',
            keyframes: wide });

const timeline = {
  take: 'ore-plant-flow',
  _what: 'Feed the dock, show the two chutes that decide what is ore, then follow a load through '
       + 'the machine in spectator. Nothing is built here — the plant is already standing.',
  schematic: list.schematic,
  parts: list.parts,
  origin: ORIGIN,
  clearStage: false,
  presentation: { heldItem: false, swing: false, sound: true, particles: true },
  cues,
};

process.stdout.write(JSON.stringify(timeline, null, 2) + '\n');
if (FILTERS.length) {
  process.stderr.write(`${FILTERS.length} filters, steepest camera ${Math.round(steepest)} degrees\n`);
}
for (const [name, s] of Object.entries(shots)) {
  process.stderr.write(`${name.padEnd(8)} ends at ${s.keyframes[2].pos.join(', ')}  `
    + `yaw ${s.keyframes[2].yaw}  visible ${Math.round(s.seen * 100)}%\n`);
}
