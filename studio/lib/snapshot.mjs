/**
 * Named versions of a project, and the way back to one.
 *
 * Saving is continuous here — every edit writes its document — which is right for working and no
 * help at all when a change turns out to have been the wrong idea an hour ago. So a snapshot is
 * the other half: a labelled copy of everything a person authored, small enough to take often.
 *
 * What goes in is the authored documents and the manifest. Audio, video and take logs stay out;
 * they are minutes of rendering rather than a decision, and they are reproducible from what is
 * kept. The schematic is the exception — it is authored in effect, since re-cutting one renumbers
 * everything — so it goes in by content hash, stored once however many snapshots point at it.
 *
 * Snapshots are taken automatically before the operations that overwrite something a person cannot
 * retype: speaking the beats (which rewrites every measured duration), restoring another snapshot,
 * re-cutting the schematic, and importing over an existing project.
 */

import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolve, relative, isWritable, ROOT } from './paths.mjs';
import { readText, writeText, writeGenerated, diffLines } from './docs.mjs';

const TEXT = /\.(json|md|txt|srt)$/;

const dir = (slug) => `snapshots/${slug}`;

/** A sortable, readable id: when it was taken, then what it was called. */
function idFor(label, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const slug = (label ?? 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${stamp}-${slug || 'snapshot'}`;
}

/** Which files a snapshot of this project holds. */
function filesOf(project) {
  const files = [project.manifest, ...Object.values(project.documents ?? {})];
  if (project.derived?.schematic) files.push(project.derived.schematic);
  if (project.derived?.groups) files.push(project.derived.groups);
  return [...new Set(files.filter(Boolean))];
}

/**
 * Takes a snapshot and returns what went into it.
 *
 * `reason` says who asked — a person, or the operation that took one on their behalf — so the list
 * reads as a history rather than as a pile of timestamps.
 */
export async function create(project, { label = 'snapshot', reason = 'asked for' } = {}) {
  const id = idFor(label);
  const base = `${dir(project.slug)}/${id}`;
  await mkdir(resolve(base), { recursive: true });
  await mkdir(resolve(`${dir(project.slug)}/.blobs`), { recursive: true });

  const entries = [];
  for (const file of filesOf(project)) {
    let data;
    try {
      data = await readFile(resolve(file));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const hash = createHash('sha256').update(data).digest('hex');
    if (TEXT.test(file)) {
      const target = `${base}/files/${file}`;
      await mkdir(path.dirname(resolve(target)), { recursive: true });
      await writeFile(resolve(target), data);
      entries.push({ path: file, kind: 'file', hash, bytes: data.length });
    } else {
      // Binary — the schematic. Stored once per distinct content, so ten snapshots across an
      // afternoon of text edits cost one copy of it rather than ten.
      const blob = `${dir(project.slug)}/.blobs/${hash}${path.extname(file)}`;
      try {
        await stat(resolve(blob));
      } catch {
        await writeFile(resolve(blob), data);
      }
      entries.push({ path: file, kind: 'blob', hash, bytes: data.length, blob });
    }
  }

  const manifest = {
    id,
    label,
    reason,
    slug: project.slug,
    taken: new Date().toISOString(),
    files: entries,
  };
  await writeFile(resolve(`${base}/snapshot.json`), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Every snapshot of a project, newest first. */
export async function list(slug) {
  let names;
  try {
    names = await readdir(resolve(dir(slug)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const manifest = JSON.parse(await readFile(resolve(`${dir(slug)}/${name}/snapshot.json`), 'utf8'));
      out.push({ ...manifest, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0) });
    } catch {
      // A half-written snapshot is not a reason to refuse to list the others.
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function readSnapshot(slug, id) {
  const manifest = JSON.parse(await readFile(resolve(`${dir(slug)}/${id}/snapshot.json`), 'utf8'));
  return manifest;
}

/** What restoring would change, file by file, without changing anything. */
export async function preview(slug, id) {
  const manifest = await readSnapshot(slug, id);
  const changes = [];
  for (const entry of manifest.files) {
    const from = entry.kind === 'blob' ? entry.blob : `${dir(slug)}/${id}/files/${entry.path}`;
    const wanted = await readFile(resolve(from));
    let current = null;
    try {
      current = await readFile(resolve(entry.path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current && Buffer.compare(current, wanted) === 0) {
      changes.push({ path: entry.path, state: 'same' });
      continue;
    }
    if (!current) {
      changes.push({ path: entry.path, state: 'restored', lines: null });
      continue;
    }
    changes.push({
      path: entry.path,
      state: 'changed',
      lines: TEXT.test(entry.path)
        ? diffLines(current.toString('utf8'), wanted.toString('utf8')).slice(0, 200)
        : null,
    });
  }
  return { id, label: manifest.label, taken: manifest.taken, changes };
}

/**
 * Puts a snapshot back.
 *
 * Takes one first, always. Restoring is itself a change somebody may want to undo, and finding out
 * afterwards that the only copy of this afternoon's work was the working tree is the failure this
 * whole file exists to prevent.
 */
export async function restore(project, id, { dryRun = false } = {}) {
  const plan = await preview(project.slug, id);
  if (dryRun) return { ...plan, restored: false };
  const safety = await create(project, { label: `before-restore-${id.slice(0, 15)}`, reason: 'automatic, before a restore' });
  const manifest = await readSnapshot(project.slug, id);
  const written = [];
  for (const entry of manifest.files) {
    const from = entry.kind === 'blob' ? entry.blob : `${dir(project.slug)}/${id}/files/${entry.path}`;
    const data = await readFile(resolve(from));
    // A snapshot holds both halves of a moment: the documents somebody wrote and the schematic and
    // parts that were true at the time. Restoring has to put both back, so generated files go
    // through the door meant for them rather than being refused as not-authored.
    if (TEXT.test(entry.path)) {
      const write = isWritable(entry.path) ? writeText : writeGenerated;
      await write(entry.path, data.toString('utf8'));
    } else {
      await mkdir(path.dirname(resolve(entry.path)), { recursive: true });
      await writeFile(resolve(entry.path), data);
    }
    written.push(entry.path);
  }
  return { ...plan, restored: true, wrote: written, safetySnapshot: safety.id };
}

export { filesOf };
