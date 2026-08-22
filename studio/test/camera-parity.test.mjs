import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import * as director from '../lib/director.mjs';
import { samplePath, bodyBlocks, CAMERA_BOX } from '../web/src/lib/cameraPath.ts';

/**
 * The curve and the camera's body exist in three places: the mod flies them, the verifier checks
 * them, and the studio draws them. Two of those are the same code; the third is a port, and a port
 * that has drifted is worse than no preview at all — it shows green for a shot that clips.
 *
 * So these compare the port against the director itself. They skip rather than fail when the game
 * is closed: most of the studio works without it, and a test suite that cannot run without
 * Minecraft open would simply not be run.
 */

const KEYFRAMES = [
  { pos: [11.9, -45.9, 23.6], yaw: 106.9, pitch: 42.5 },
  { pos: [8, -48, 18], yaw: 60, pitch: 20 },
  { pos: [4, -50, 10], yaw: -170, pitch: 0 },
  { pos: [2, -52, 4], yaw: 170, pitch: -10 },
];

const up = async () => (await director.status()).up;

for (const ease of ['inOut', 'linear']) {
  test(`the drawn curve is the flown curve — ${ease}`, async (t) => {
    if (!await up()) return t.skip('the recording instance is not running');
    const samples = 120;
    const fromGame = await director.path({ keyframes: KEYFRAMES, durationMs: 4000, ease, samples });
    const fromStudio = samplePath(KEYFRAMES, ease, samples);
    assert.equal(fromGame.samples.length, fromStudio.length);

    let worst = 0;
    let worstYaw = 0;
    for (let i = 0; i < fromStudio.length; i++) {
      const there = fromGame.samples[i];
      const here = fromStudio[i];
      worst = Math.max(worst, Math.hypot(
        there.pos[0] - here.pos[0], there.pos[1] - here.pos[1], there.pos[2] - here.pos[2]));
      // The short way round: 350° and 10° are twenty degrees apart, not three hundred and forty.
      const yawGap = Math.abs(((there.yaw - here.yaw + 540) % 360) - 180);
      worstYaw = Math.max(worstYaw, yawGap);
    }
    // Float arithmetic in two languages, nothing more. A real drift is orders of magnitude larger.
    assert.ok(worst < 1e-4, `positions differ by up to ${worst} blocks`);
    assert.ok(worstYaw < 1e-2, `yaw differs by up to ${worstYaw} degrees`);
  });
}

test('the body the studio draws is the body the verifier measures', async (t) => {
  if (!await up()) return t.skip('the recording instance is not running');
  // Where the mod says a sample is blocked, the box the studio draws must contain the block it
  // named — the same 0.6 cube with the eye 0.4 up it, not a point and not a standing player.
  const fromGame = await director.path({ keyframes: KEYFRAMES, durationMs: 4000, ease: 'inOut', samples: 200 });
  const blocked = fromGame.samples.filter((sample) => sample.blocked);
  assert.ok(blocked.length > 0, 'this path is meant to pass through the plant');
  for (const sample of blocked) {
    const box = bodyBlocks(sample.pos);
    const named = sample.at.split(', ').map(Number).join(',');
    assert.ok(box.includes(named),
      `the mod found ${named} inside the camera at ${sample.pos}, the studio's box does not reach it`);
  }
  assert.deepEqual(CAMERA_BOX, { half: 0.3, below: 0.4, above: 0.2 });
});
