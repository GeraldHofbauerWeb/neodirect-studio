/**
 * Builds the narrated episode: the same follow-style build, fitted to the voice.
 *
 *   node tools/mk-episode.mjs > script/ore-plant.json
 *
 * The run-through in tools/mk-build-take.mjs sets its own pace — a fixed interval per block, one
 * assembly after another. This one is handed a fixed stretch of narration per assembly and works
 * the interval out backwards, so the boiler finishes going up exactly as the sentence about the
 * boiler finishes. Rewrite a sentence, re-render the voice, run this again, and the building
 * re-times itself around the new audio.
 *
 * Where an assembly cannot fill its beat at a sane pace — the washer is seven blocks under
 * thirty-eight seconds of narration — the placement is clamped and the camera arcs around the
 * finished thing for the rest. Seven blocks crawling across a beat reads as a stall, not as care.
 */

import { readFile } from 'node:fs/promises';
import { bounds, moveFor, occupancy, waterReach } from './frame-parts.mjs';
import { followCues, unitsFor } from './follow-shots.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};

const list = JSON.parse(await readFile(arg('shots', 'script/ore-plant.shots.json'), 'utf8'));
const stations = JSON.parse(await readFile(arg('stations', 'script/ore-plant.stations.json'), 'utf8'));
const script = JSON.parse(await readFile(arg('beats', 'script/ore-plant.beats.json'), 'utf8'));

for (const beat of script.beats) {
  if (beat.measuredMs == null || beat.startMs == null) {
    throw new Error(`beat ${beat.id} has no measured audio — run "render-voice.mjs render" first`);
  }
}
const beatOf = new Map(script.beats.map((b) => [b.id, b]));

const ORIGIN = list.origin;
const groups = JSON.parse(await readFile(`schematics/${list.parts}`, 'utf8'));
const occupied = occupancy(groups, ORIGIN);
const noStanding = new Set([...occupied, ...waterReach(groups, ORIGIN)]);
const filterAt = new Map((groups.filters ?? []).map((f) => [f.pos.join(','), f]));
const PACE = Object.fromEntries([['default', list.paceDefault], ...list.bulk.map((id) => [id, list.paceBulk])]);

const cues = [];
const report = [];
const placed = new Set();
const remember = (name) => {
  for (const p of groups.parts[name]) placed.add(`${p[0] + ORIGIN[0]},${p[1] + ORIGIN[1]},${p[2] + ORIGIN[2]}`);
};

// The housing, under the opening beat. Nobody is looking at it — the camera is on the chest being
// counted out — and it has to be standing before anything is bolted to it.
const shell = list.shots.find((s) => s.part === 'shell');
const shellSpan = Math.min(beatOf.get('b0').measuredMs - 2000, 12000);
cues.push({ type: 'place', atMs: 300, blocks: { part: 'shell' }, spanMs: shellSpan, pace: PACE,
            _what: shell.what });
remember('shell');

// b0 — the bill, read off a real inventory rather than asserted.
const chest = list.materialsChest ?? [22, 1, 8];
const b0 = beatOf.get('b0');
cues.push({ type: 'materialsChest', atMs: 200, pos: chest, facing: 'west', large: true,
            ignoreContentsOf: ['create:item_vault', 'minecraft:chest', 'quark:oak_chest', 'minecraft:barrel'],
            _what: 'every kind in the build, once — the chests inside the plant hold product, which is stock and not a cost' });
cues.push({ type: 'camera', atMs: 0, durationMs: b0.measuredMs, _what: 'the chest',
            keyframes: [[29, -58, 8], [26, -58.6, 8], [24.6, -59, 8]].map((pos) => {
              const t = [chest[0] + ORIGIN[0] + 0.5, chest[1] + ORIGIN[1] + 0.6, chest[2] + ORIGIN[2] + 0.5];
              const dx = t[0] - pos[0];
              const dy = t[1] - pos[1];
              const dz = t[2] - pos[2];
              return { pos,
                       yaw: Math.round(-Math.atan2(dx, dz) * 573) / 10,
                       pitch: Math.round(-Math.atan2(dy, Math.hypot(dx, dz)) * 573) / 10 };
            }) });
cues.push({ type: 'screen', atMs: Math.round(b0.measuredMs * 0.12), action: 'open', pos: chest });
cues.push({ type: 'screen', atMs: Math.round(b0.measuredMs * 0.94), action: 'close' });

for (const shot of list.shots) {
  if (!shot.beat) continue;
  const beat = beatOf.get(shot.beat);
  if (!beat) throw new Error(`shot "${shot.part}" names beat ${shot.beat}, which the script has no audio for`);
  const blocks = groups.parts[shot.part];

  // How much of the beat this assembly owns. Two assemblies sharing a beat split it at beatAt.
  const share = list.shots.filter((s) => s.beat === shot.beat).sort((a, b) => a.beatAt - b.beatAt);
  const next = share[share.indexOf(shot) + 1];
  const from = beat.startMs + (shot.beatAt ?? 0) * beat.measuredMs;
  const until = beat.startMs + (next ? next.beatAt : 1) * beat.measuredMs;
  const window = until - from;

  const units = unitsFor(blocks, filterAt);
  const wanted = Math.round(window / units);
  const msPerBlock = Math.min(list.episode.maxMsPerBlock,
                              Math.max(list.episode.minMsPerBlock, wanted));

  const { cues: follow, span, runs, lastPose } = followCues({
    name: shot.part, what: shot.what, blocks, placed, noStanding, origin: ORIGIN, filterAt,
    msPerBlock, glideShare: list.defaults.glideShare, startAt: Math.round(from),
  });
  cues.push(...follow);

  // Whatever is left of the beat after the last block: a slow turn around the finished assembly
  // rather than a frozen frame, and it is also the only wide look the close style ever gives.
  const left = Math.round(until - (from + span));
  if (left > 1500) {
    const { lo, size } = bounds(blocks);
    cues.push({ type: 'camera', atMs: Math.round(from + span), durationMs: left,
                _what: `${shot.part} — finished, while the narration carries on`,
                keyframes: moveFor(lo, size, ORIGIN, shot.bearing, occupied, shot.lift) });
  } else if (left > 0) {
    cues.push({ type: 'camera', atMs: Math.round(from + span), durationMs: Math.max(1, left),
                _what: `${shot.part} — finished`, keyframes: [lastPose, lastPose] });
  }

  cues.push({ type: 'marker', atMs: Math.round(from), label: `${shot.beat} · ${shot.part}` });
  report.push(`${shot.beat}  ${shot.part.padEnd(11)} ${String(blocks.length).padStart(3)} blocks  `
    + `${String(msPerBlock).padStart(4)} ms/block  ${runs.length} shots  `
    + `${span} of ${Math.round(window)} ms${left > 1500 ? `, ${left} ms held` : ''}`);
}

// b9 — throw the switch, then feed it. The lever is on one side of a block and a redstone torch on
// the other: off, the torch burns, the wire carries fifteen, and a powered clutch is a disengaged
// one, so the wheels turn nothing and the boiler stays dry. Throwing it puts current into the
// block, the torch goes out, and everything after it comes alive at once.
const b9 = beatOf.get('b9');
const finish = list.finish;
cues.push({ type: 'use', atMs: Math.round(b9.startMs + 0.04 * b9.measuredMs), pos: finish.lever,
            _what: 'the boiler switch, pulled' });
// And only then the kinetic blocks, bare. A cloned water wheel is right in every way except which
// network it believes it is on, and setBlock returns early when handed the state already there —
// so it has to go to air and come back with none of its saved data.
cues.push({ type: 'reseat', atMs: Math.round(b9.startMs + 0.09 * b9.measuredMs), ofType: finish.reseat,
            _what: 'every pure kinetic block, bare, so it finds the network it is actually on' });
for (const [at, station] of [[0.16, 'crusher'], [0.24, 'washer'], [0.34, 'press']]) {
  const def = stations.stations.find((s) => s.name === station);
  if (!def) continue;
  cues.push({ type: 'marker', atMs: Math.round(b9.startMs + at * b9.measuredMs), label: `b9 · ${station}` });
}
cues.push({ type: 'fill', atMs: Math.round(b9.startMs + 0.14 * b9.measuredMs), pos: stations.dock.fillPos,
            items: stations.load, _what: 'a train-load: ore, raw ore, and the stone that came up with it' });
// Spectator for the last stretch: nothing after this places a block or opens a screen, and it
// takes the hand and the hotbar out of every remaining frame.
cues.push({ type: 'gameMode', atMs: Math.round(b9.startMs + 0.12 * b9.measuredMs), mode: 'spectator' });

const readout = bounds(groups.parts[finish.holdPart]);
cues.push({ type: 'camera', atMs: Math.round(b9.startMs + 0.42 * b9.measuredMs),
            durationMs: Math.round(0.58 * b9.measuredMs) + 4000,
            _what: 'the wall, once it is running',
            keyframes: moveFor(readout.lo, readout.size, ORIGIN,
                               list.shots.find((s) => s.part === finish.holdPart).bearing, occupied, 0) });

cues.sort((a, b) => a.atMs - b.atMs);
process.stdout.write(JSON.stringify({
  take: 'ore-plant',
  _generated: 'from script/ore-plant.beats.json by tools/mk-episode.mjs — edit the script or the '
            + 'shot list and run it again, never this file.',
  schematic: list.schematic,
  parts: list.parts,
  origin: ORIGIN,
  clearStage: true,
  presentation: { heldItem: true, swing: true, sound: true, particles: true },
  cues: [...cues, { type: 'marker', atMs: script.totalMs, label: 'end of narration' }],
}, null, 2) + '\n');

for (const line of report) process.stderr.write(line + '\n');
process.stderr.write(`\nnarration ${Math.round(script.totalMs / 1000)} s, ${cues.length} cues\n`);
