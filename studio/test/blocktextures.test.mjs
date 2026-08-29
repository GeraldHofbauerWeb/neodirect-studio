/**
 * The block atlas the game hands over, checked against the build it is meant to describe.
 *
 * The cache is a product of a running instance, so these run when one has been asked and skip when
 * it has not — like the parity tests, and for the same reason: there is nothing to check about an
 * answer that was never given.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { invoke } from '../lib/ops.mjs';
import * as docs from '../lib/docs.mjs';
import * as director from '../lib/director.mjs';
import * as schematic from '../lib/schematic.mjs';

const cached = await docs.readJsonIfPresent('studio/blocktextures/ore-plant.json');
const game = await director.status();

// Nothing cached and no instance to ask: there is no atlas in this checkout, which is the normal
// state of a fresh clone.
const missing = !cached && !game.up;

test('every block of the build has a face in the atlas', { skip: missing }, async () => {
  const atlas = cached?.value ?? (await ask()).value;
  const types = Object.keys((await schematic.summary('schematics/ore_plant.nbt')).types);

  for (const id of types) {
    const faces = atlas.blocks[id];
    assert.ok(faces, `${id} is in the build and not in the atlas`);
    for (const face of ['top', 'side', 'bottom']) {
      assert.equal(typeof faces[face], 'number', `${id} has no ${face}`);
      // −1 is "this block has no picture", which the viewport paints as its map colour. Anything
      // else has to point at a tile that exists, or the shader samples somebody else's texture.
      assert.ok(faces[face] === -1 || faces[face] < atlas.columns * atlas.rows,
        `${id}'s ${face} points past the end of the atlas`);
    }
  }
});

test('the atlas is a PNG of the size its index claims', { skip: missing }, async () => {
  const atlas = cached?.value ?? (await ask()).value;
  const prefix = 'data:image/png;base64,';
  assert.ok(atlas.atlas.startsWith(prefix), 'the atlas travels inside its own index');

  const bytes = Buffer.from(atlas.atlas.slice(prefix.length), 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature');
  // IHDR: width and height as big-endian 32-bit, straight after the signature and length/type.
  assert.equal(bytes.readUInt32BE(16), atlas.columns * atlas.tile);
  assert.equal(bytes.readUInt32BE(20), atlas.rows * atlas.tile);
});

test('a block the game does not know is named, not skipped', { skip: missing }, async () => {
  const atlas = cached?.value ?? (await ask()).value;
  assert.ok(Array.isArray(atlas.missing));
  assert.deepEqual(atlas.missing, [],
    'this build uses only blocks the instance has — a name here means a mod is absent');
});

/** Asks the instance, when the cache is not there but the game is. */
async function ask() {
  await invoke('block_appearance', { slug: 'ore-plant' });
  return docs.readJson('studio/blocktextures/ore-plant.json');
}
