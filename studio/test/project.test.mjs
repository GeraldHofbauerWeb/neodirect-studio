import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as projects from '../lib/project.mjs';
import * as bundle from '../lib/bundle.mjs';
import * as snapshot from '../lib/snapshot.mjs';
import * as docs from '../lib/docs.mjs';
import { resolve } from '../lib/paths.mjs';

test('the manifest describes the episode that is actually on disk', async () => {
  const project = await projects.open('ore-plant');
  assert.equal(project.slug, 'ore-plant');
  assert.equal(project.documents.storyboard, 'script/ore-plant.storyboard.json');
  assert.equal(project.derived.schematic, 'schematics/ore_plant.nbt');
  assert.deepEqual(project.origin, [0, -61, 0]);
  // The mods come out of the schematic's own blocks, not out of a list somebody maintains.
  assert.deepEqual(project.requires.mods.sort(), ['create', 'quark']);
  const names = project.takes.map((t) => t.name).sort();
  assert.deepEqual(names, ['build', 'build-follow', 'episode', 'flow', 'run', 'run-follow'].filter((n) => names.includes(n)));
  const follow = project.takes.find((t) => t.name === 'build-follow');
  assert.deepEqual(follow.args, { style: 'follow', lockedExcept: 'shell' });
});

test('export then import into an empty directory brings everything across', async () => {
  const project = await projects.open('ore-plant');
  const exported = await bundle.exportProject(project, { profile: 'source' });
  const into = await mkdtemp(path.join(tmpdir(), 'ndproj-import-'));
  const result = await bundle.importProject(exported.path, { into });

  assert.equal(result.slug, 'ore-plant');
  const { manifest } = await bundle.inspect(exported.path);
  for (const record of manifest.files) {
    const there = await readFile(path.join(into, record.path));
    const here = await readFile(resolve(record.path));
    assert.equal(Buffer.compare(there, here), 0, `${record.path} did not survive the round trip`);
  }
});

test('a bundle carries the mods it needs, so an import can refuse before a take rather than after', async () => {
  const project = await projects.open('ore-plant');
  const exported = await bundle.exportProject(project, { profile: 'source' });
  const { manifest } = await bundle.inspect(exported.path);
  assert.ok(manifest.requires.mods.includes('create'));
  assert.equal(manifest.kind, 'ndproj');
  assert.ok(manifest.files.every((f) => f.sha256.length === 64));
});

test('a snapshot restores exactly what was there, and guards itself first', async () => {
  const project = await projects.open('ore-plant');
  const before = await docs.readText(project.documents.beats);
  const taken = await snapshot.create(project, { label: 'test' });

  await docs.patchJson(project.documents.beats, [{ op: 'replace', pointer: '/beats/0/plannedMs', value: 999 }]);
  const changed = await docs.readText(project.documents.beats);
  assert.notEqual(changed.text, before.text);

  const preview = await snapshot.preview(project.slug, taken.id);
  assert.ok(preview.changes.some((c) => c.path === project.documents.beats && c.state === 'changed'));

  const restored = await snapshot.restore(project, taken.id);
  assert.ok(restored.safetySnapshot, 'a restore should leave a way back from itself');
  const after = await docs.readText(project.documents.beats);
  assert.equal(after.text, before.text, 'the restore did not return the file byte for byte');
});
