/**
 * Reading and writing the authored documents.
 *
 * Writes are atomic (write a neighbour, rename over the target) because the game and the tools
 * read these files while the studio has them open, and half a storyboard parses as nothing at all.
 * Structured edits go through {@link ../lib/json-edit.mjs}, so a changed field is a changed field
 * and not a reformatted document.
 */

import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyEdits, parse, locate, render } from './json-edit.mjs';
import { resolve, relative, assertWritable, assertGenerated, ROOT } from './paths.mjs';

/** Raw text of a document, plus what the filesystem knows about it. */
export async function readText(relPath) {
  const full = resolve(relPath);
  const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
  return { path: relPath, text, modified: info.mtimeMs, size: info.size };
}

/** A JSON document, parsed. */
export async function readJson(relPath) {
  const { text, modified } = await readText(relPath);
  return { path: relPath, value: JSON.parse(text), text, modified };
}

/** Same, but tolerating a document that is not there yet. */
export async function readJsonIfPresent(relPath) {
  try {
    return await readJson(relPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** SHA-256 of a file, the way the export manifest records it. */
export async function hashOf(relPath) {
  const buffer = await readFile(resolve(relPath));
  return createHash('sha256').update(buffer).digest('hex');
}

/** Writes text over a document, atomically, refusing anything generated. */
export async function writeText(relPath, text) {
  assertWritable(relPath);
  const full = resolve(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  const temporary = `${full}.studio-${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, full);
  return { path: relPath, bytes: Buffer.byteLength(text) };
}

/**
 * Writes a file a tool generated, on that tool's behalf.
 *
 * The guard is still there, only wider: a take, a resolved parts file, a schematic, anything under
 * `out/`. What it will not do is let a generator write over a storyboard.
 */
export async function writeGenerated(relPath, text) {
  assertGenerated(relPath);
  const full = resolve(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  const temporary = `${full}.studio-${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, full);
  return { path: relPath, bytes: Buffer.byteLength(text) };
}

/** Writes a value as a whole new document, in the house style. */
export async function writeJson(relPath, value) {
  return writeText(relPath, render(value, '', '  ') + '\n');
}

/**
 * Applies structured edits to a JSON document.
 *
 * `expectModified` is the optimistic lock: pass what you last read and the write refuses if
 * something else has touched the file since. Two panels and an MCP call editing one storyboard is
 * the normal case here, not an exotic one.
 */
export async function patchJson(relPath, ops, { expectModified = null } = {}) {
  const before = await readText(relPath);
  if (expectModified !== null && Math.abs(before.modified - expectModified) > 1) {
    throw new Error(`${relPath} changed since you read it — read it again before writing`);
  }
  const after = applyEdits(before.text, ops);
  if (after === before.text) return { path: relPath, changed: false, value: JSON.parse(after) };
  await writeText(relPath, after);
  return { path: relPath, changed: true, value: JSON.parse(after) };
}

/** The value at a pointer, without loading the whole document into the caller's hands. */
export async function readPointer(relPath, pointer) {
  const { text } = await readText(relPath);
  const { node, missing } = locate(parse(text), pointer);
  return missing ? undefined : node.value;
}

/** A unified-ish diff of two texts, for showing what a restore or an import would do. */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // Look ahead for the next line that lines up again; anything before it is the change.
    let resync = -1;
    for (let k = 1; k < 40 && resync === -1; k++) {
      if (a[i + k] !== undefined && a[i + k] === b[j]) resync = k;
    }
    if (resync !== -1) {
      for (let k = 0; k < resync; k++) changes.push({ side: '-', line: i + k + 1, text: a[i + k] });
      i += resync;
      continue;
    }
    let resyncB = -1;
    for (let k = 1; k < 40 && resyncB === -1; k++) {
      if (b[j + k] !== undefined && b[j + k] === a[i]) resyncB = k;
    }
    if (resyncB !== -1) {
      for (let k = 0; k < resyncB; k++) changes.push({ side: '+', line: j + k + 1, text: b[j + k] });
      j += resyncB;
      continue;
    }
    if (a[i] !== undefined) changes.push({ side: '-', line: i + 1, text: a[i] });
    if (b[j] !== undefined) changes.push({ side: '+', line: j + 1, text: b[j] });
    i++;
    j++;
  }
  return changes;
}

export { ROOT, relative, resolve };
