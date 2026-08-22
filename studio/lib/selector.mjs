/**
 * What a `place` cue's `blocks` field actually names.
 *
 * This is a port of `Cue.Place.Selector` and `Director#resolve`, and it exists so the studio can
 * answer "which blocks is this cue about" while the game is closed — the whole point of a
 * selector builder is seeing the answer as you type it. The director stays the authority: with an
 * instance running, `POST /scrub` builds the world and the two can be held against each other.
 *
 * The part that is easy to get wrong is `rest`. Selectors are resolved in cue order against one
 * shared set of claimed indices, so `rest` means "everything no *earlier* cue took", and an
 * `except` list holds a type back for a later cue. Resolving a cue in isolation would quietly
 * give a different answer than the take does.
 */

/** Reads the several shapes a `blocks` field is allowed to have. */
export function parseSelector(blocks) {
  if (blocks === 'all') return { kind: 'range', from: 0, to: Infinity };
  if (blocks === 'rest') return { kind: 'rest', except: [] };
  if (Array.isArray(blocks)) return { kind: 'indices', values: blocks.map(Number) };
  if (blocks && typeof blocks === 'object') {
    if ('ofType' in blocks) {
      const ids = Array.isArray(blocks.ofType) ? blocks.ofType : [blocks.ofType];
      return { kind: 'ofType', ids };
    }
    if ('part' in blocks || 'parts' in blocks) {
      const named = blocks.part ?? blocks.parts;
      return { kind: 'part', names: Array.isArray(named) ? named : [named] };
    }
    if (blocks.rest) {
      const held = blocks.except ?? [];
      return { kind: 'rest', except: Array.isArray(held) ? held : [held] };
    }
    if ('from' in blocks || 'to' in blocks) {
      return { kind: 'range', from: Number(blocks.from ?? 0), to: Number(blocks.to ?? Infinity) };
    }
  }
  throw new Error(`cannot read a block selector out of ${JSON.stringify(blocks)}`);
}

/** Human wording for a selector, for a cue chip that has to fit in a timeline lane. */
export function describeSelector(selector) {
  switch (selector.kind) {
    case 'indices': return selector.values.length > 6
      ? `${selector.values.length} blocks by index`
      : `blocks ${selector.values.join(', ')}`;
    case 'range': return selector.to === Infinity && selector.from === 0
      ? 'everything' : `blocks ${selector.from}–${selector.to}`;
    case 'ofType': return `every ${selector.ids.join(', ')}`;
    case 'part': return selector.names.join(' + ');
    case 'rest': return selector.except.length
      ? `everything else except ${selector.except.join(', ')}` : 'everything else';
    default: return selector.kind;
  }
}

/**
 * Resolves one selector against the schematic.
 *
 * `claimed` is the running set of indices earlier cues took; it is read by `rest` and extended
 * with whatever this selector resolves to, so passing the same set through a timeline's cues in
 * order reproduces what the director does.
 */
export function resolveSelector(selector, { blockList, parts }, claimed = new Set()) {
  const resolved = [];
  switch (selector.kind) {
    case 'indices':
      for (const index of selector.values) {
        if (index >= 0 && index < blockList.length) resolved.push(index);
      }
      break;
    case 'range': {
      const from = Math.max(0, selector.from);
      const to = Math.min(blockList.length - 1, selector.to);
      for (let i = from; i <= to; i++) resolved.push(i);
      break;
    }
    case 'ofType': {
      const wanted = new Set(selector.ids);
      blockList.forEach((block, i) => {
        if (wanted.has(block.id)) resolved.push(i);
      });
      if (resolved.length === 0) {
        throw new Error(`no blocks of type ${selector.ids.join(', ')} in the schematic`);
      }
      break;
    }
    case 'part':
      for (const name of selector.names) {
        const indices = parts?.[name];
        if (!indices) {
          throw new Error(`no part named "${name}" — the manifest has ${Object.keys(parts ?? {}).join(', ')}`);
        }
        resolved.push(...indices);
      }
      break;
    case 'rest': {
      const held = new Set(selector.except);
      blockList.forEach((block, i) => {
        if (claimed.has(i)) return;
        if (!held.has(block.id)) resolved.push(i);
      });
      break;
    }
    default:
      throw new Error(`unknown selector ${selector.kind}`);
  }
  for (const index of resolved) claimed.add(index);
  return resolved;
}

/**
 * Every `place` cue of a timeline or storyboard, resolved in order.
 *
 * Returns what each cue claims, plus the blocks nobody does — the same warning the director logs
 * at load time, which is what stops "everything else now" and "the storage goes on last" from
 * silently fighting over the vaults.
 */
export function resolveTimeline(cues, schematic) {
  const claimed = new Set();
  const perCue = [];
  for (const [index, cue] of cues.entries()) {
    if (cue.type !== 'place') continue;
    try {
      const selector = parseSelector(cue.blocks);
      const indices = resolveSelector(selector, schematic, claimed);
      perCue.push({ cue: index, selector, describe: describeSelector(selector), indices });
    } catch (error) {
      perCue.push({ cue: index, error: error.message, indices: [] });
    }
  }
  const unplaced = [];
  schematic.blockList.forEach((block, i) => {
    if (!claimed.has(i)) unplaced.push({ i, pos: block.pos, id: block.id });
  });
  const byType = {};
  for (const block of unplaced) byType[block.id] = (byType[block.id] ?? 0) + 1;
  return { perCue, claimed: claimed.size, unplaced, unplacedByType: byType };
}
