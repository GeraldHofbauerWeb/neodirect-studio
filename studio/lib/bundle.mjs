/**
 * A project as one file: `<slug>.ndproj`.
 *
 * Everything an episode is made of is spread across `script/`, `schematics/` and `out/`, tied
 * together by a manifest. Handing that to somebody means handing them all of it, in a form that
 * says what it needs — above all *which mods*, because a block whose mod is missing is read as air
 * by the loader and vanishes from the build without a word. An import that checks first is the
 * difference between an episode that does not build and an episode that builds wrong.
 *
 * Three profiles, because "share it" means three different things:
 *
 *   source     what somebody needs to carry on working: documents, schematic, parts, alignments,
 *              subtitles, take logs. No audio — the repository leaves mp3s out on purpose, and
 *              the alignments make the timings reproducible without them.
 *   full       plus the rendered voice and the snapshots. For moving between machines.
 *   delivery   the finished video, its subtitles, and a readable summary. Not a project at all —
 *              the thing the project was for.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolve, relative, ROOT } from './paths.mjs';
import * as archive from './archive.mjs';
import * as snapshot from './snapshot.mjs';
import * as schematic from './schematic.mjs';
import { voiceDir } from '../../tools/render-voice.mjs';

export const FORMAT_VERSION = 1;
export const PROFILES = ['source', 'full', 'delivery'];

const sha = (data) => createHash('sha256').update(data).digest('hex');

async function readIfPresent(relPath) {
  try {
    return await readFile(resolve(relPath));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listIfPresent(dir) {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(resolve(dir))).map((name) => `${dir}/${name}`);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Which files a profile takes with it. */
async function filesFor(project, profile) {
  const files = [project.manifest, ...Object.values(project.documents ?? {})];
  files.push(project.derived?.schematic, project.derived?.groups);
  for (const take of project.takes ?? []) files.push(take.out);

  if (project.derived?.schematic) {
    files.push(project.derived.schematic.replace(/\.nbt$/, '.report.json'));
  }

  const voice = project.documents?.beats ? voiceDir(project.documents.beats) : null;
  if (voice) {
    for (const file of await listIfPresent(voice)) {
      const keep = profile === 'full'
        ? true
        : /\.alignment\.json$|\.srt$/.test(file);
      if (keep) files.push(file);
    }
  }
  for (const take of project.takes ?? []) {
    if (!take.out) continue;
    const name = path.basename(take.out, '.json');
    files.push(`out/${name}.log.json`);
  }

  if (profile === 'full') {
    for (const dir of await listIfPresent(`snapshots/${project.slug}`)) {
      if (dir.endsWith('/.blobs')) continue;
      files.push(...await walk(dir));
    }
  }

  const seen = new Set();
  const out = [];
  for (const file of files.filter(Boolean)) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (await readIfPresent(file)) out.push(file);
  }
  return out;
}

async function walk(dir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const entry of await readdir(resolve(dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(child));
    else out.push(child);
  }
  return out;
}

/** A readable summary, so a delivery bundle says what it is without opening the video. */
function deliveryReadme(project, beats) {
  const lines = [
    `# ${project.name}`,
    '',
    `Recorded with NeoDirect. ${beats?.beats?.length ?? 0} beats, ` +
      `${beats?.totalMs ? (beats.totalMs / 1000).toFixed(1) + ' s of narration' : 'no narration'}.`,
    '',
  ];
  for (const beat of beats?.beats ?? []) {
    const at = typeof beat.startMs === 'number' ? `${(beat.startMs / 1000).toFixed(1)} s` : '—';
    lines.push(`## ${beat.id} · ${at}`, '', beat.text, '');
  }
  return lines.join('\n');
}

/**
 * Writes a bundle and returns where it went, plus what is in it.
 *
 * The manifest carries a hash per file, which is what lets an import say "this arrived damaged"
 * instead of failing later and stranger.
 */
export async function exportProject(project, { profile = 'source', out = null } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`unknown profile ${profile} — one of ${PROFILES.join(', ')}`);
  const entries = [];
  const manifestFiles = [];

  if (profile === 'delivery') {
    const beats = project.documents?.beats
      ? JSON.parse(await readFile(resolve(project.documents.beats), 'utf8')) : null;
    const voice = project.documents?.beats ? voiceDir(project.documents.beats) : null;
    const candidates = [
      ...(project.takes ?? []).map((t) => `out/${path.basename(t.out ?? '', '.json')}.mp4`),
      voice ? `${voice}/subtitles.srt` : null,
    ].filter(Boolean);
    for (const file of candidates) {
      const data = await readIfPresent(file);
      if (!data) continue;
      entries.push({ name: path.basename(file), data });
      manifestFiles.push({ path: path.basename(file), bytes: data.length, sha256: sha(data) });
    }
    const readme = deliveryReadme(project, beats);
    entries.push({ name: 'README.md', data: readme });
    manifestFiles.push({ path: 'README.md', bytes: Buffer.byteLength(readme), sha256: sha(Buffer.from(readme)) });
  } else {
    for (const file of await filesFor(project, profile)) {
      const data = await readFile(resolve(file));
      entries.push({ name: file, data });
      manifestFiles.push({ path: file, bytes: data.length, sha256: sha(data) });
    }
  }

  const mods = project.derived?.schematic
    ? await schematic.requiredMods(project.derived.schematic).catch(() => project.requires?.mods ?? [])
    : project.requires?.mods ?? [];

  const manifest = {
    kind: 'ndproj',
    formatVersion: FORMAT_VERSION,
    profile,
    exported: new Date().toISOString(),
    project: {
      name: project.name,
      slug: project.slug,
      world: project.world,
      origin: project.origin,
      manifest: project.manifest,
      takes: (project.takes ?? []).map((t) => ({ name: t.name, out: t.out })),
    },
    requires: { ...(project.requires ?? {}), mods },
    files: manifestFiles,
  };
  const bytes = archive.write([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    ...entries,
  ]);

  const target = out ?? `out/export/${project.slug}-${profile}.ndproj`;
  await mkdir(path.dirname(resolve(target)), { recursive: true });
  await writeFile(resolve(target), bytes);
  return { path: target, profile, bytes: bytes.length, files: manifestFiles.length, manifest };
}

/** What is in a bundle, without unpacking it into the tree. */
export async function inspect(file) {
  const buffer = await readFile(path.isAbsolute(file) ? file : resolve(file));
  const entries = archive.read(buffer);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error(`${file} has no manifest.json — is it a .ndproj?`);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const damaged = [];
  for (const record of manifest.files ?? []) {
    const entry = entries.find((e) => e.name === record.path || e.name === path.basename(record.path));
    if (!entry) damaged.push({ path: record.path, why: 'missing from the archive' });
    else if (sha(entry.data) !== record.sha256) damaged.push({ path: record.path, why: 'checksum does not match' });
  }
  return { manifest, entries: entries.map((e) => ({ name: e.name, bytes: e.data.length })), damaged, buffer };
}

/**
 * Unpacks a bundle into the tree.
 *
 * Refuses to write over an existing project unless told what to call this one instead; an import
 * that silently merges into an episode somebody is working on is a way to lose an afternoon. What
 * it does do automatically is take a snapshot first when it is importing over something.
 */
export async function importProject(file, { as = null, force = false, into = null } = {}) {
  const { manifest, damaged, buffer } = await inspect(file);
  if (damaged.length && !force) {
    throw new Error(`${file} is damaged: ${damaged.map((d) => `${d.path} (${d.why})`).join(', ')}`);
  }
  if (manifest.profile === 'delivery') {
    throw new Error('this is a delivery bundle — video and subtitles, not a project to work on');
  }
  const entries = archive.read(buffer);
  const slug = as ?? manifest.project.slug;
  const rename = slug !== manifest.project.slug;
  const root = into ?? ROOT;

  const existing = await stat(path.resolve(root, `script/${slug}.project.json`)).then(() => true).catch(() => false);
  if (existing && !force) {
    throw new Error(`${slug} is already here — import it under another name with "as", or pass force`);
  }
  if (existing) {
    const project = await (await import('./project.mjs')).open(slug);
    await snapshot.create(project, { label: `before-import`, reason: 'automatic, before an import' });
  }

  const wrote = [];
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue;
    const target = rename ? entry.name.split(manifest.project.slug).join(slug) : entry.name;
    const full = path.resolve(root, target);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, entry.data);
    wrote.push(target);
  }
  return { slug, files: wrote, renamed: rename, requires: manifest.requires, from: file };
}
