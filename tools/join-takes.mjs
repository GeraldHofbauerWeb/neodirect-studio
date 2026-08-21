/**
 * Lays several takes end to end into one, so a run is one recording rather than a pile of clips.
 *
 *   node tools/join-takes.mjs script/ore-plant-build.json script/ore-plant-flow.json \
 *     --gap 2000 --take ore-plant-run > script/ore-plant-run.json
 *
 * Each take keeps its own cue times; this shifts the later ones past the end of the earlier ones.
 * Nothing else is merged — the takes must already agree about the schematic, the parts file and
 * the origin, and it says so rather than guessing if they do not.
 *
 * `clearStage` is taken from the first take alone. The second take is a continuation by
 * definition: it films what the first one built.
 */

import { readFile } from 'node:fs/promises';

const files = [];
let gap = 2000;
let name = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--gap') gap = Number(argv[++i]);
  else if (argv[i] === '--take') name = argv[++i];
  else files.push(argv[i]);
}
if (files.length < 2) throw new Error('usage: node tools/join-takes.mjs <a.json> <b.json> [...] [--gap ms] [--take name]');

const takes = [];
for (const file of files) takes.push(JSON.parse(await readFile(file, 'utf8')));

const [first] = takes;
for (const take of takes.slice(1)) {
  for (const key of ['schematic', 'parts']) {
    if (take[key] !== first[key]) {
      throw new Error(`${key} differs: ${first[key]} vs ${take[key]} — these are not the same build`);
    }
  }
  if (String(take.origin) !== String(first.origin)) {
    throw new Error(`origin differs: ${first.origin} vs ${take.origin}`);
  }
}

const cues = [];
let offset = 0;
for (const take of takes) {
  const end = take.cues.reduce((m, c) => Math.max(m, c.atMs + (c.durationMs ?? 0)), 0);
  for (const cue of take.cues) cues.push({ ...cue, atMs: cue.atMs + offset });
  offset += end + gap;
}
cues.sort((a, b) => a.atMs - b.atMs);

process.stdout.write(JSON.stringify({
  take: name ?? takes.map((t) => t.take).join('+'),
  _what: 'Joined by tools/join-takes.mjs from ' + files.join(' and ')
       + '. Edit those, not this — it is regenerated.',
  schematic: first.schematic,
  parts: first.parts,
  origin: first.origin,
  clearStage: first.clearStage,
  presentation: first.presentation,
  cues,
}, null, 2) + '\n');
process.stderr.write(`${cues.length} cues, ${Math.round((offset - gap) / 1000)} s\n`);
