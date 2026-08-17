/**
 * Checks the built contraption against its schematic.
 *
 *   node tools/verify.mjs script/full-build.json
 *
 * Answers "does it end up looking exactly like the schematic" as a fact rather than an impression:
 * every block state is compared, entity counts per type are compared, and loose items on the
 * ground are counted — litter means a block entity was destroyed somewhere and spilled its
 * inventory.
 */

import { readFile } from 'node:fs/promises';

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';

const [timelinePath] = process.argv.slice(2);
if (!timelinePath) throw new Error('usage: node tools/verify.mjs <timeline.json>');

const timeline = await readFile(timelinePath, 'utf8');
const response = await fetch(`${CONTROL}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: timeline,
});
const report = await response.json();
if (report.error) throw new Error(report.error);

console.log(`blocks: ${report.matched}/${report.blocksInSchematic} match` +
  `  missing ${report.missing}  wrong state ${report.wrongState}`);

if (report.unknownBlocks?.length) {
  console.log(`\n! ${report.unknownBlocks.length} block type(s) unknown to this instance — they were silently dropped:`);
  for (const id of report.unknownBlocks) console.log(`    ${id}`);
  console.log('  Install the mod in the recording instance, or swap the block in the schematic.');
}

if (report.entities) {
  for (const [id, counts] of Object.entries(report.entities)) {
    const mark = counts.expected === counts.actual ? ' ' : '!';
    console.log(`${mark} ${id}: ${counts.actual}/${counts.expected}`);
  }
}
console.log(`loose items on the ground: ${report.looseItems}`);

if (report.cameraClearance?.length) {
  console.log(`\n! ${report.cameraClearance.length} camera move(s) pass through the build:`);
  for (const c of report.cameraClearance) {
    console.log(`    at ${c.atMs} ms — ${c.blockedSamples}/${c.ofSamples} samples inside blocks, first at ${c.firstAt} (${c.insideBlock})`);
  }
} else {
  console.log('camera paths: clear');
}

if (report.mismatches?.length) {
  console.log('\nmismatches:');
  for (const m of report.mismatches) {
    console.log(`  ${m.pos.padEnd(12)} expected ${m.expected}\n  ${''.padEnd(12)} actual   ${m.actual}`);
  }
}

const entitiesOk = !report.entities ||
  Object.values(report.entities).every((c) => c.expected === c.actual);
const clean = report.ok && entitiesOk && report.looseItems === 0
  && !(report.cameraClearance?.length);

console.log(`\n${clean ? 'OK — the world matches the schematic' : 'NOT CLEAN'}`);
process.exit(clean ? 0 : 1);
