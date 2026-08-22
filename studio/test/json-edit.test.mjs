import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { applyEdits, parse, locate, pointerOf } from '../lib/json-edit.mjs';

const REPO = new URL('../../', import.meta.url);

async function documents() {
  const found = [];
  for (const dir of ['script', 'schematics']) {
    for (const name of await readdir(new URL(dir + '/', REPO))) {
      if (name.endsWith('.json')) found.push(dir + '/' + name);
    }
  }
  return found;
}

test('every document in the repository parses, values and all', async () => {
  const files = await documents();
  assert.ok(files.length >= 10, `expected the real documents, found ${files.length}`);
  for (const file of files) {
    const text = await readFile(new URL(file, REPO), 'utf8');
    const root = parse(text);
    assert.deepEqual(root.value, JSON.parse(text), `${file} parses to something else than JSON.parse does`);
    assert.equal(text.slice(root.start, root.end).trim(), text.trim(), `${file}: root span is wrong`);
  }
});

test('an empty edit list is the identity', async () => {
  for (const file of await documents()) {
    const text = await readFile(new URL(file, REPO), 'utf8');
    assert.equal(applyEdits(text, []), text, `${file} changed with nothing to change`);
  }
});

test('replacing a value writes back what was there, byte for byte', async () => {
  // Every leaf, replaced with its own value: a change that says nothing must move nothing.
  const file = 'script/ore-plant.storyboard.json';
  const text = await readFile(new URL(file, REPO), 'utf8');
  const root = parse(text);
  const pointers = [];
  const walk = (node, path) => {
    if (node.kind === 'object') for (const m of node.members) walk(m.node, [...path, m.key]);
    else if (node.kind === 'array') node.items.forEach((item, i) => walk(item, [...path, i]));
    else pointers.push(pointerOf(...path));
  };
  walk(root, []);
  assert.ok(pointers.length > 200, `expected a real document, found ${pointers.length} leaves`);
  for (const pointer of pointers) {
    const { node } = locate(root, pointer);
    const out = applyEdits(text, [{ op: 'replace', pointer, value: node.value }]);
    assert.equal(out, text, `replacing ${pointer} with itself changed the file`);
  }
});

test('a real change touches only its own lines', async () => {
  const text = await readFile(new URL('script/ore-plant.beats.json', REPO), 'utf8');
  const out = applyEdits(text, [{ op: 'replace', pointer: '/beats/3/plannedMs', value: 12345 }]);
  assert.equal(JSON.parse(out).beats[3].plannedMs, 12345);
  const before = text.split('\n');
  const after = out.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 1, `expected one changed line, got ${changed.length}`);
});

test('set creates a key, remove takes it away again', async () => {
  const text = await readFile(new URL('script/pilot-a.json', REPO), 'utf8');
  const added = applyEdits(text, [{ op: 'set', pointer: '/notes', value: { why: 'testing' } }]);
  assert.deepEqual(JSON.parse(added).notes, { why: 'testing' });
  const removed = applyEdits(added, [{ op: 'remove', pointer: '/notes' }]);
  assert.equal(removed, text, 'set then remove did not return the original');
});

test('add and remove keep an array valid at both ends', async () => {
  const text = await readFile(new URL('script/pilot-a.json', REPO), 'utf8');
  for (const index of [0, 3, 7]) {
    const added = applyEdits(text, [{ op: 'add', pointer: '/cues', value: { type: 'marker', atMs: 1, label: 'x' }, index }]);
    const cues = JSON.parse(added).cues;
    assert.equal(cues.length, JSON.parse(text).cues.length + 1);
    assert.equal(cues[Math.min(index, cues.length - 1)].label, 'x');
    const back = applyEdits(added, [{ op: 'remove', pointer: `/cues/${Math.min(index, cues.length - 1)}` }]);
    assert.deepEqual(JSON.parse(back), JSON.parse(text), `add/remove at ${index} lost something`);
  }
});

test('editing a nested value keeps the indentation of where it landed', async () => {
  const text = await readFile(new URL('script/ore-plant.storyboard.json', REPO), 'utf8');
  const out = applyEdits(text, [{ op: 'replace', pointer: '/presentation', value: { heldItem: false, swing: true } }]);
  assert.match(out, /\n {2}"presentation": \{\n {4}"heldItem": false,\n {4}"swing": true\n {2}\}/);
});
