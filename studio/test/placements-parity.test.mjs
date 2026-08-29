/**
 * The ported placement arithmetic against the director's own.
 *
 * `studio/lib/placements.mjs` works out when each block appears so the studio can show a build
 * going up under the playhead without the game being open. That makes it the fourth place in this
 * repository that knows a timeline truth, and the only defence against a port drifting from its
 * original is to ask the original.
 *
 * `POST /scrub` reports every step it ran with the millisecond it belonged to, so the comparison is
 * exact rather than approximate: not "about the same number of blocks", but the same instants.
 *
 * Skipped, not failed, when the instance is closed — it is a check on agreement between two
 * implementations, and with one of them absent there is nothing to disagree about.
 *
 * Note that this rebuilds the world in the recording instance, exactly as running a take does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { invoke } from '../lib/ops.mjs';
import * as director from '../lib/director.mjs';
import * as docs from '../lib/docs.mjs';
import * as projects from '../lib/project.mjs';

const game = await director.status();
const TAKE = 'build';
const AT = [40_000, 110_000];

test('a placement lands at the same millisecond as the director puts it', { skip: !game.up }, async () => {
  if (game.running) {
    assert.fail('a take is running — this test would rebuild the world under it');
  }
  const ours = await invoke('placement_times', { slug: 'ore-plant', take: TAKE });
  const project = await projects.open('ore-plant');
  const { value: timeline } = await docs.readJson(projects.takeNamed(project, TAKE).out);

  for (const ms of AT) {
    const scrub = await director.scrub(timeline, ms);
    const theirs = [...scrub.events]
      .filter((event) => event.kind === 'place')
      .map((event) => event.atMs)
      .sort((a, b) => a - b);
    const mine = Object.values(ours.times).filter((at) => at <= ms).sort((a, b) => a - b);

    assert.equal(mine.length, theirs.length,
      `at ${ms} ms the studio expects ${mine.length} blocks and the director placed ${theirs.length}`);
    assert.deepEqual(mine, theirs, `the placement instants differ at ${ms} ms`);
  }
});
