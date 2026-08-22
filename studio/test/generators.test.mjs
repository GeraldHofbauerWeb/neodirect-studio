import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
const generate = (args) => execFileSync('node', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] });
const onDisk = (file) => readFile(new URL(file, new URL('../../', import.meta.url)), 'utf8');

/**
 * The shot tables used to live in the generators as source. Moving them into documents is only
 * safe if the output does not move with them — otherwise every take would have to be re-framed for
 * a refactor. So both styles are generated and compared byte for byte against what is committed.
 */
test('the arc take comes out of the shot list exactly as it is committed', async () => {
  const generated = generate(['tools/mk-build-take.mjs', '--style', 'arc', '--locked-except', '']);
  assert.equal(generated, await onDisk('script/ore-plant-build.json'));
});

test('the follow take comes out of the shot list exactly as it is committed', async () => {
  const generated = generate(['tools/mk-build-take.mjs']);
  assert.equal(generated, await onDisk('script/ore-plant-build-follow.json'));
});

test('the flow take comes out of the station list exactly as it is committed', async () => {
  const generated = generate(['tools/mk-flow-take.mjs']);
  assert.equal(generated, await onDisk('script/ore-plant-flow.json'));
});

test('a shot may name its own style, and only that assembly changes', async () => {
  const asCommitted = JSON.parse(generate(['tools/mk-build-take.mjs']));
  const list = JSON.parse(await onDisk('script/ore-plant.shots.json'));
  // Say it out loud rather than through the exception list: same meaning, so the same take.
  list.defaults.except = [];
  list.shots = list.shots.map((shot) => (shot.part === 'shell' ? { ...shot, style: 'arc' } : shot));
  const temporary = new URL('../../script/.test.shots.json', import.meta.url);
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(temporary, JSON.stringify(list, null, 2) + '\n');
  try {
    const generated = JSON.parse(generate(['tools/mk-build-take.mjs', 'script/.test.shots.json']));
    assert.deepEqual(generated.cues, asCommitted.cues,
      'naming a style per assembly should mean the same thing as the exception list did');
  } finally {
    await unlink(temporary);
  }
});

test('the follow style is the one with the linear camera runs', async () => {
  const arc = JSON.parse(await onDisk('script/ore-plant-build.json'));
  const follow = JSON.parse(await onDisk('script/ore-plant-build-follow.json'));
  const linear = (take) => take.cues.filter((c) => c.type === 'camera' && c.ease === 'linear').length;
  assert.equal(linear(arc), 0, 'an arc take should not need linear easing');
  assert.ok(linear(follow) > 20, 'a follow take is mostly linear runs');
  // Every camera cue is a real move or a deliberate hold, never a single keyframe.
  for (const take of [arc, follow]) {
    for (const cue of take.cues.filter((c) => c.type === 'camera')) {
      assert.ok(cue.keyframes.length >= 2, 'the director refuses a camera cue with fewer than two keyframes');
    }
  }
});
