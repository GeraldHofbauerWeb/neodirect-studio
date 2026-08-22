import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as archive from '../lib/archive.mjs';

const REPO = new URL('../../', import.meta.url);

test('a round trip through the archive returns exactly what went in', async () => {
  const nbt = await readFile(new URL('schematics/ore_plant.nbt', REPO));
  const json = await readFile(new URL('script/ore-plant.storyboard.json', REPO));
  const entries = [
    { name: 'manifest.json', data: '{"kind":"ndproj"}' },
    { name: 'schematics/ore_plant.nbt', data: nbt },
    { name: 'script/ore-plant.storyboard.json', data: json },
    { name: 'empty.txt', data: '' },
  ];
  const back = archive.read(archive.write(entries));
  assert.equal(back.length, entries.length);
  assert.equal(Buffer.compare(back[1].data, nbt), 0, 'the schematic came back changed');
  assert.equal(back[2].data.toString('utf8'), json.toString('utf8'));
  assert.equal(back[3].data.length, 0);
});

test('the same input twice produces the same bytes', () => {
  const once = archive.write([{ name: 'a.json', data: '{"a":1}' }]);
  const twice = archive.write([{ name: 'a.json', data: '{"a":1}' }]);
  assert.equal(Buffer.compare(once, twice), 0, 'exports are not reproducible');
});

test('the system unzip agrees that it is a zip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ndproj-'));
  const file = path.join(dir, 'probe.zip');
  await writeFile(file, archive.write([
    { name: 'manifest.json', data: '{"kind":"ndproj"}' },
    { name: 'nested/thing.txt', data: 'x'.repeat(5000) },
  ]));
  const output = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.match(output, /No errors detected/);
});

test('damage is caught rather than unpacked', () => {
  const bytes = archive.write([{ name: 'a.txt', data: 'hello there' }]);
  // Flip a byte in the middle of the stored data.
  const wrecked = Buffer.from(bytes);
  wrecked[40] ^= 0xff;
  assert.throws(() => archive.read(wrecked), /checksum|damaged|malformed|unpacked/i);
});
