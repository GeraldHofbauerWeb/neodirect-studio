import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { COMMANDS } from '../lib/jobs.mjs';

const REPO = new URL('../../', import.meta.url);

/**
 * The point of the studio is that nothing has to be run by hand any more. That claim only stays
 * true if every tool in the repository is reachable through it, so this fails when one is added
 * without a way to start it.
 */
test('every tool in tools/ can be started from the studio', async () => {
  const runnable = (await readdir(new URL('tools/', REPO)))
    .filter((name) => /\.(mjs|py|sh)$/.test(name))
    .filter((name) => !/^(nbtio|aim|obs|capture|frame-parts|follow-shots)\b/.test(name))    // libraries, not commands
    .filter((name) => !name.startsWith('test_'));
  const covered = new Set(Object.values(COMMANDS)
    .flatMap((spec) => {
      try {
        const [, args] = spec.build({ beats: 'x', storyboard: 'x', out: 'x', timeline: 'x', takes: ['a', 'b'], schematic: 'x', manifest: 'x', spec: 'x', source: 'x', edits: 'x', x: 0, z: 0, task: 'x', which: 'all', at: [] });
        return args.filter((arg) => arg.startsWith('tools/'));
      } catch {
        return [];
      }
    })
    .map((arg) => arg.replace(/^tools\//, '')));
  // The python test runner is reached through the `tests` command rather than by name.
  covered.add('test_nbt_tools.py');
  const missing = runnable.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `no studio operation starts: ${missing.join(', ')}`);
});
