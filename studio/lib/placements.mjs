/**
 * When each block appears, in milliseconds of the episode.
 *
 * The storyboard says a cue starts at a beat and spreads its blocks over a stretch; it does not
 * say when the fourth block of six hundred goes down. The director works that out at run time, and
 * until now nothing outside the game could: the studio could show *which* blocks a cue places and
 * not *when*, which is exactly the question a playhead asks.
 *
 * This is a port of the arithmetic in {@code Director#expand} — the weights, the spread, the way
 * the last block lands exactly at the end. A port, and therefore a liability: it is the fourth
 * place in this repository that knows a timeline truth, after the director itself, the selector
 * and the camera curve. `studio/test/placements-parity.test.mjs` holds it against `POST /scrub`
 * with the game running, which is the only check worth anything here.
 */

/**
 * A block's share of its cue: its own position first, then its block id, then `default`, then one.
 * Position beats id because it is the more specific statement of the two.
 */
export function weightOf(pace, block) {
  if (!pace || !Object.keys(pace).length) return 1;
  const here = pace[block.pos.join(',')];
  if (here !== undefined) return here;
  const own = pace[block.id];
  if (own !== undefined) return own;
  return pace.default ?? 1;
}

/**
 * The offsets from the start of a cue, one per block, in cue order.
 *
 * The weights redistribute the time inside the cue and never lengthen it: the last block lands at
 * the end of the spread exactly as it would if every step were the same size. That is why the
 * denominator is the total weight *minus the last block's* — the last block has no gap after it.
 */
export function offsetsFor({ pace, spanMs = 0, staggerMs = 0 }, blocks) {
  if (!blocks.length) return [];
  const weights = blocks.map((block) => weightOf(pace, block));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const spreadOut = spanMs > 0 && blocks.length > 1;
  const spread = spreadOut ? spanMs : staggerMs * Math.max(0, blocks.length - 1);
  const leading = total - weights[weights.length - 1];

  const offsets = [];
  let running = 0;
  for (let i = 0; i < blocks.length; i++) {
    offsets.push(leading > 0 ? Math.round(spread * (running / leading)) : 0);
    running += weights[i];
  }
  return offsets;
}

/**
 * Every block of an episode with the millisecond it appears.
 *
 * @param cues   resolved cues, as `cues_list` returns them: `atMsResolved` and `blocksResolved`
 * @param placed for each cue index, the block indices it places, in cue order
 * @param blocks the schematic's block list, so a pace can be read by position or by block id
 * @returns `{ times: {blockIndex: ms}, firstMs, lastMs }`
 */
export function times({ cues, placedByCue, blocks }) {
  const byIndex = new Map(blocks.map((block) => [block.i, block]));
  const times = {};

  for (const cue of cues) {
    if (cue.type !== 'place' || cue.atMsResolved === null) continue;
    const indices = placedByCue[cue.index] ?? [];
    const theirs = indices.map((i) => byIndex.get(i)).filter(Boolean);
    if (!theirs.length) continue;
    const offsets = offsetsFor(cue, theirs);
    theirs.forEach((block, n) => {
      // First claim wins, the way the director's own `claimed` set works: a block placed by an
      // earlier cue is not placed again by a later one that happens to match it too.
      if (times[block.i] === undefined) times[block.i] = cue.atMsResolved + offsets[n];
    });
  }

  const all = Object.values(times);
  return {
    times,
    firstMs: all.length ? Math.min(...all) : null,
    lastMs: all.length ? Math.max(...all) : null,
    placed: all.length,
  };
}
