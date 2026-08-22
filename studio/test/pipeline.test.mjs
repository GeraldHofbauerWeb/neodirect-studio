import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from '../lib/pipeline.mjs';
import * as projects from '../lib/project.mjs';

test('a beat counts as spoken only when the audio says the same words', async () => {
  // The pilot has been spoken; its alignments spell what its beats say.
  const pilot = await pipeline.beats('script/pilot.beats.json');
  assert.equal(pilot.voice, 'out/voice/pilot');
  assert.ok(pilot.measured, 'the pilot should be fully measured');
  assert.ok(pilot.beats.every((b) => b.state === 'fresh'));

  // The ore plant has not been spoken at all — and shares its beat ids with the pilot, which is
  // exactly why the audio lives per episode rather than in one flat directory.
  const orePlant = await pipeline.beats('script/ore-plant.beats.json');
  assert.equal(orePlant.voice, 'out/voice/ore-plant');
  assert.ok(!orePlant.measured);
  assert.ok(orePlant.beats.every((b) => b.state === 'missing'));
});

test('every link says what it is and, when it is not fresh, how to fix it', async () => {
  // Deliberately not asserting a particular state: whether this repository's takes happen to be
  // current is a fact about today, and a test that encodes it fails the first time somebody
  // regenerates one. What has to hold is the contract — a link is one of the four states, and
  // anything but fresh explains itself and carries a way out.
  const project = await projects.open('ore-plant');
  const status = await pipeline.status(project);
  assert.ok(['fresh', 'suspect', 'stale', 'missing'].includes(status.state));
  assert.ok(status.links.length > 0, 'an episode with five takes has derivations');
  for (const link of status.links) {
    assert.ok(link.from && link.to, 'a link joins two things');
    assert.ok(['fresh', 'suspect', 'stale', 'missing'].includes(link.state));
    if (link.state === 'fresh') continue;
    assert.ok(link.why, 'a stale link with no explanation is just a red light');
    assert.ok(link.fix?.command, `${link.why} names no way to fix it`);
    // Which take a fix belongs to has to travel with it: two takes share a generator and differ
    // only by their arguments, and regenerating one with the other's throws away its framing.
    if (['mk-build-take', 'mk-flow-take', 'join-takes'].includes(link.fix.command)) {
      assert.ok(link.fix.params?.take, `${link.fix.command} does not say which take it would write`);
    }
  }
});

test('a time-only mismatch is called suspect, not stale', async () => {
  const project = await projects.open('ore-plant');
  const { utimes } = await import('node:fs/promises');
  const { resolve } = await import('../lib/paths.mjs');
  const take = project.takes.find((t) => t.name === 'build');
  const now = new Date();
  // Touch the input without changing a byte of it — exactly what restoring a snapshot does.
  await utimes(resolve(project.documents.shots), now, now);
  const status = await pipeline.status(project);
  const link = status.links.find((l) => l.to === take.out);
  assert.equal(link.state, 'suspect');
  assert.match(link.why, /may come out identical/);
});

test('the report is checked against the schematic rather than against its own age', async () => {
  const project = await projects.open('ore-plant');
  const status = await pipeline.status(project);
  const note = status.notes.find((n) => n.text.includes('report.json'));
  // This one is real: the committed report predates the last re-cut.
  assert.ok(note, 'the stale report should be reported');
  assert.match(note.text, /says \d+ blocks, the schematic has \d+/);
});

test('the pilot is fresh, so a clean project reports clean', async () => {
  const project = await projects.open('episode');
  const status = await pipeline.status(project);
  assert.ok(status.narration.measured);
  assert.equal(status.links.filter((l) => l.state === 'stale').length, 0);
});
