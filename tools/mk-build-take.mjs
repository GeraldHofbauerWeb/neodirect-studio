/**
 * Writes the silent build take: the plant going up one assembly at a time, then the switch.
 *
 *   node tools/mk-build-take.mjs > script/ore-plant-build.json
 *
 * No narration under it. This is the run-through that proves the machine can be built from the
 * schematic and will run when it is finished, and it is the thing to watch when a shot needs
 * re-framing. The narrated version comes from script/ore-plant.storyboard.json, which fits the
 * same placements to the measured beats.
 */

import { readFile } from 'node:fs/promises';
import { bounds, moveFor, occupancy } from './frame-parts.mjs';

const ORIGIN = [0, -61, 0];
const groups = JSON.parse(await readFile('schematics/ore_plant.groups.json', 'utf8'));
const occupied = occupancy(groups, ORIGIN);

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

const cues = [];
let at = 500;
for (const [name, shot] of Object.entries(SHOTS)) {
  const { lo, size } = bounds(palette[name]);
  const span = spanFor(name);
  cues.push({ type: 'camera', atMs: at, durationMs: span + 3000, _what: name,
              keyframes: moveFor(lo, size, ORIGIN, shot.bearing, occupied, shot.lift) });
  cues.push({ type: 'place', atMs: at + 400, blocks: { part: name }, spanMs: span,
              pace: PACE, _what: shot.what });
  cues.push({ type: 'marker', atMs: at + span + 1200, label: name });
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
  take: 'ore-plant-build',
  _what: 'A silent run-through. One camera move per assembly, held for a moment after the assembly '
       + 'finishes, then the switch is pulled, the kinetic blocks are reseated bare, and the camera '
       + 'stays on the wall. Placement time inside a cue goes to the components rather than to the '
       + 'floor they stand on.',
  schematic: 'ore_plant.nbt',
  parts: 'ore_plant.groups.json',
  origin: ORIGIN,
  clearStage: true,
  presentation: { heldItem: true, swing: true, sound: true, particles: true },
  cues,
}, null, 2) + '\n');

for (const name of Object.keys(SHOTS)) {
  process.stderr.write(`${name.padEnd(11)} ${String(palette[name].length).padStart(3)} blocks  span ${spanFor(name)} ms\n`);
}
process.stderr.write(`total ${at + 16000} ms\n`);
