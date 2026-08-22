/**
 * A project: the episode as one thing you can open, snapshot, export and hand to somebody.
 *
 * Everything a project names already existed as a file; what was missing was the knot tying them
 * together. Which beats file belongs to which storyboard was written inside the storyboard, which
 * schematic belongs to which clip spec was in a filename, and which command produced which take
 * was in somebody's shell history. `project.json` says all of it out loud.
 *
 * Two layouts, because moving the existing episodes would be a churn for nothing:
 *
 *   adopted      `script/<slug>.project.json`, pointing at today's paths in script/ and schematics/
 *   standalone   `projects/<slug>/project.json`, with its own script/ and schematics/ beside it
 *
 * A project is never invented silently: {@link discover} lists what is on disk, and says which
 * episodes *could* be adopted, but writing the file is something somebody asks for.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, resolve, relative } from './paths.mjs';
import { readJson, readJsonIfPresent, writeJson, patchJson } from './docs.mjs';
import * as schematic from './schematic.mjs';

export const FORMAT_VERSION = 1;

const exists = async (relPath) => {
  try {
    await stat(resolve(relPath));
    return true;
  } catch {
    return false;
  }
};

async function listing(dir) {
  try {
    return await readdir(resolve(dir));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Where a project's manifest lives, given its slug and layout. */
export function manifestPath(slug, layout = 'adopted') {
  return layout === 'standalone' ? `projects/${slug}/project.json` : `script/${slug}.project.json`;
}

/** Every project on disk, plus every episode that has the files but not the knot. */
export async function discover() {
  const projects = [];
  for (const name of await listing('script')) {
    if (name.endsWith('.project.json')) {
      projects.push(await read(`script/${name}`));
    }
  }
  for (const name of await listing('projects')) {
    const file = `projects/${name}/project.json`;
    if (await exists(file)) projects.push(await read(file));
  }

  const known = new Set(projects.map((p) => p.slug));
  const adoptable = [];
  for (const name of await listing('script')) {
    if (!name.endsWith('.storyboard.json')) continue;
    const slug = name.replace(/\.storyboard\.json$/, '');
    if (known.has(slug)) continue;
    adoptable.push({ slug, storyboard: `script/${name}` });
  }
  return { projects, adoptable };
}

/** Reads a manifest and resolves its paths relative to where the manifest sits. */
export async function read(manifest) {
  const { value } = await readJson(manifest);
  const base = path.dirname(manifest);
  const resolveDoc = (p) => (p ? relative(path.resolve(ROOT, base === 'script' ? '.' : base, p)) : null);
  const documents = Object.fromEntries(
    Object.entries(value.documents ?? {}).map(([k, v]) => [k, resolveDoc(v)]));
  const derived = Object.fromEntries(
    Object.entries(value.derived ?? {}).map(([k, v]) => [k, resolveDoc(v)]));
  const takes = (value.takes ?? []).map((take) => ({ ...take, out: resolveDoc(take.out) }));
  return { ...value, manifest, base, documents, derived, takes };
}

/**
 * Builds a manifest for an episode that already exists, out of what its files say.
 *
 * Nothing here is guessed twice: the beats file, the schematic and the parts file are named by the
 * storyboard, the origin is the storyboard's, the world follows the naming the build already uses,
 * and the mods come out of the schematic's own block namespaces rather than from a list somebody
 * has to remember to update.
 */
export async function adopt(slug, { layout = 'adopted', name = null } = {}) {
  const storyboardPath = `script/${slug}.storyboard.json`;
  const { value: storyboard } = await readJson(storyboardPath);
  const beatsPath = `script/${storyboard.beats}`;
  const schematicPath = `schematics/${storyboard.schematic}`;
  const groupsPath = storyboard.parts ? `schematics/${storyboard.parts}` : null;
  const partsManifest = groupsPath ? groupsPath.replace(/\.groups\.json$/, '.parts.json') : null;
  const clip = `schematics/${storyboard.schematic.replace(/\.nbt$/, '.clip.json')}`;
  const beats = await readJsonIfPresent(beatsPath);

  const documents = { storyboard: storyboardPath, beats: beatsPath };
  const prose = beatsPath.replace(/\.json$/, '.md');
  if (await exists(prose)) documents.prose = prose;
  for (const [key, file] of [['shots', `script/${slug}.shots.json`], ['stations', `script/${slug}.stations.json`]]) {
    if (await exists(file)) documents[key] = file;
  }
  if (partsManifest && await exists(partsManifest)) documents.partsManifest = partsManifest;
  if (await exists(clip)) documents.clip = clip;

  const derived = { schematic: schematicPath };
  if (groupsPath) derived.groups = groupsPath;

  const takes = [];
  for (const name of await listing('script')) {
    if (!name.startsWith(slug) || !name.endsWith('.json')) continue;
    if (name.includes('.storyboard') || name.includes('.beats') || name.includes('.project')
        || name.includes('.shots') || name.includes('.stations')) continue;
    const takeName = name === `${slug}.json` ? 'episode' : name.slice(slug.length + 1, -5);
    takes.push({ name: takeName, ...specFor(takeName), out: `script/${name}` });
  }

  const mods = await schematic.requiredMods(schematicPath).catch(() => []);
  const summary = await schematic.summary(schematicPath).catch(() => null);

  const manifest = {
    formatVersion: FORMAT_VERSION,
    _what: 'Ties one episode together: which prose, which beats, which storyboard, which schematic, '
      + 'and which takes come out of them. Written and maintained by the studio; the documents it '
      + 'names are still the source of truth, this only says which ones belong to each other.',
    name: name ?? slug,
    slug,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    world: `neodirect-${slug}`,
    origin: storyboard.origin ?? [0, 0, 0],
    documents,
    derived,
    takes,
    requires: { mods, minecraft: '1.21.1', neoforge: '21.1.x' },
    voice: beats ? { voiceId: beats.value.voiceId, voiceName: beats.value.voiceName } : null,
    stats: summary ? { blocks: summary.blocks, size: summary.size } : null,
  };
  const file = manifestPath(slug, layout);
  await writeJson(file, manifest);
  return read(file);
}

/**
 * Which tool writes a take of this name, and with which arguments.
 *
 * This is the knowledge that used to live in somebody's shell history: that `ore-plant-build.json`
 * is the arc style with no exceptions and `ore-plant-build-follow.json` is the follow style with
 * the shell left arcing. Two files that differ by a flag are otherwise indistinguishable on disk,
 * and regenerating one with the other's arguments is a quiet way to lose an afternoon of framing.
 */
function specFor(takeName) {
  if (takeName === 'episode') return { generator: 'make-timeline' };
  if (takeName.startsWith('flow')) return { generator: 'mk-flow-take' };
  if (takeName.startsWith('run')) {
    const suffix = takeName.slice('run'.length);
    return { generator: 'join-takes', args: { of: [`build${suffix}`, 'flow'], gap: 2000 } };
  }
  const follow = takeName.endsWith('follow');
  return {
    generator: 'mk-build-take',
    args: follow ? { style: 'follow', lockedExcept: 'shell' } : { style: 'arc', lockedExcept: '' },
  };
}

/** Opens a project by slug, adopting it first if it has never been opened. */
export async function open(slug, { adoptIfMissing = true } = {}) {
  for (const layout of ['adopted', 'standalone']) {
    const file = manifestPath(slug, layout);
    if (await exists(file)) return read(file);
  }
  if (!adoptIfMissing) throw new Error(`no project called ${slug}`);
  return adopt(slug);
}

/** Records a change to the manifest itself, keeping `modified` honest. */
export async function update(project, ops) {
  return patchJson(project.manifest, [
    ...ops,
    { op: 'set', pointer: '/modified', value: new Date().toISOString() },
  ]);
}

/** A take variant by name, with the arguments that reproduce it. */
export function takeNamed(project, name) {
  const take = project.takes.find((t) => t.name === name);
  if (!take) {
    throw new Error(`${project.slug} has no take called "${name}" — it has ${project.takes.map((t) => t.name).join(', ')}`);
  }
  return take;
}
