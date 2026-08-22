/**
 * The schematic, as something a browser can draw.
 *
 * The file is compressed structure NBT; `tools/schematic_json.py` turns it into the block list the
 * director counts — air dropped by name, sorted bottom-up — and this caches that per file and
 * modification time, because a 926-block plant is a tenth of a second to decode and the viewport
 * asks for it on every switch of panel.
 */

import { stat } from 'node:fs/promises';
import { resolve } from './paths.mjs';
import { readJson } from './docs.mjs';
import * as jobs from './jobs.mjs';

const cache = new Map();

async function cached(key, relPath, produce) {
  const info = await stat(resolve(relPath));
  const hit = cache.get(key);
  if (hit && hit.modified === info.mtimeMs) return hit.value;
  const value = await produce();
  cache.set(key, { modified: info.mtimeMs, value });
  return value;
}

/** Everything in a schematic: sizes, counts, and the ordered block list. */
export async function load(relPath, { nbt = false } = {}) {
  return cached(`${relPath}:${nbt}`, relPath, async () => {
    const result = await jobs.run('schematic-json', { schematic: relPath, blocks: true, nbt });
    return JSON.parse(result.stdout);
  });
}

/** Counts and namespaces only — what the dashboard and the doctor need. */
export async function summary(relPath) {
  return cached(`${relPath}:summary`, relPath, async () => {
    const result = await jobs.run('schematic-json', { schematic: relPath, blocks: false });
    return JSON.parse(result.stdout);
  });
}

/**
 * The resolved parts file, with its positions turned into the indices a cue means.
 *
 * `parts.py` writes positions on purpose — an index is only true for one cut of the schematic —
 * so the mapping happens here, against the block list, exactly as the director does it. A position
 * that no longer exists is reported rather than skipped: it means the manifest and the schematic
 * have come apart, which is the failure the position form exists to make loud.
 */
export async function groups(groupsPath, schematicPath) {
  return cached(`${groupsPath}:${schematicPath}`, groupsPath, async () => {
    const { value } = await readJson(groupsPath);
    const schematic = await load(schematicPath);
    const byPos = new Map(schematic.blockList.map((b) => [b.pos.join(','), b.i]));
    const parts = {};
    const stale = [];
    for (const [name, positions] of Object.entries(value.parts ?? {})) {
      parts[name] = [];
      for (const pos of positions) {
        const index = byPos.get(pos.join(','));
        if (index === undefined) stale.push({ part: name, pos });
        else parts[name].push(index);
      }
    }
    return { parts, ids: value.ids ?? {}, blocks: value.blocks, stale, schematic: value.schematic };
  });
}

/** Which mods a schematic needs, read off the blocks rather than typed into a manifest. */
export async function requiredMods(relPath) {
  const { namespaces } = await summary(relPath);
  return namespaces.filter((ns) => ns !== 'minecraft');
}

export function forget() {
  cache.clear();
}
