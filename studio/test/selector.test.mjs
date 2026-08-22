import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as schematic from '../lib/schematic.mjs';
import { readJson } from '../lib/docs.mjs';
import { parseSelector, resolveSelector, resolveTimeline, describeSelector } from '../lib/selector.mjs';

const load = async () => {
  const blocks = await schematic.load('schematics/ore_plant.nbt');
  const { parts } = await schematic.groups('schematics/ore_plant.groups.json', 'schematics/ore_plant.nbt');
  return { blockList: blocks.blockList, parts };
};

test('the block list is in the order a cue means by an index', async () => {
  const { blockList } = await load();
  for (let i = 1; i < blockList.length; i++) {
    const a = blockList[i - 1].pos;
    const b = blockList[i].pos;
    const before = a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[0] <= b[0])));
    assert.ok(before, `blocks ${i - 1} and ${i} are out of the director's order`);
  }
  assert.ok(blockList.every((b) => !b.air), 'air should not be in the list the director counts');
});

test('every selector shape reads', () => {
  assert.deepEqual(parseSelector('all'), { kind: 'range', from: 0, to: Infinity });
  assert.deepEqual(parseSelector('rest'), { kind: 'rest', except: [] });
  assert.deepEqual(parseSelector([1, 2]), { kind: 'indices', values: [1, 2] });
  assert.deepEqual(parseSelector({ from: 0, to: 40 }), { kind: 'range', from: 0, to: 40 });
  assert.deepEqual(parseSelector({ ofType: 'create:deployer' }), { kind: 'ofType', ids: ['create:deployer'] });
  assert.deepEqual(parseSelector({ part: 'crushing' }), { kind: 'part', names: ['crushing'] });
  assert.deepEqual(parseSelector({ rest: true, except: ['create:item_vault'] }), { kind: 'rest', except: ['create:item_vault'] });
  assert.throws(() => parseSelector({ nonsense: 1 }), /cannot read a block selector/);
});

test('the ore plant storyboard places every block exactly once', async () => {
  const shape = await load();
  const { value: storyboard } = await readJson('script/ore-plant.storyboard.json');
  const resolved = resolveTimeline(storyboard.cues, shape);
  assert.equal(resolved.unplaced.length, 0, 'some blocks would never be built');
  assert.equal(resolved.claimed, shape.blockList.length);
  const counted = resolved.perCue.reduce((n, cue) => n + cue.indices.length, 0);
  assert.equal(counted, shape.blockList.length, 'a block is claimed twice');
});

test('rest means what an earlier cue left, and except holds a type back for a later one', async () => {
  const shape = await load();
  const claimed = new Set();
  const vaults = resolveSelector(parseSelector({ ofType: 'create:item_vault' }), shape, new Set());
  assert.ok(vaults.length > 0);

  // Sweep up everything except the vaults, the way the pilot storyboard does.
  const sweep = resolveSelector(parseSelector({ rest: true, except: ['create:item_vault'] }), shape, claimed);
  assert.ok(!sweep.some((i) => shape.blockList[i].id === 'create:item_vault'),
    'the sweep took the vaults the closing beat was built around');

  // What is left afterwards is exactly the vaults.
  const remaining = resolveSelector(parseSelector('rest'), shape, claimed);
  assert.deepEqual(remaining.sort((a, b) => a - b), vaults.sort((a, b) => a - b));
});

test('a part is named, not guessed, and a missing one is loud', async () => {
  const shape = await load();
  const crushing = resolveSelector(parseSelector({ part: 'crushing' }), shape, new Set());
  assert.equal(crushing.length, shape.parts.crushing.length);
  assert.throws(() => resolveSelector(parseSelector({ part: 'crusher' }), shape, new Set()), /no part named/);
  assert.equal(describeSelector(parseSelector({ part: 'crushing' })), 'crushing');
});

test('a type nothing in the schematic has is refused rather than resolving to nothing', async () => {
  const shape = await load();
  assert.throws(() => resolveSelector(parseSelector({ ofType: 'minecraft:sponge' }), shape, new Set()),
    /no blocks of type/);
});
