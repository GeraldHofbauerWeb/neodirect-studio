/**
 * Every operation the studio can perform, defined once.
 *
 * There are two front doors — a browser and an MCP client — and it would be very easy for them to
 * drift: a button that calls a tool the agent cannot reach, an agent tool nobody put in the UI. So
 * neither of them defines anything. Both are generated from this table, and a contract test fails
 * the moment an operation exists in one and not the other.
 *
 * Each entry says what it takes, whether it writes anything, and whether it needs the game to be
 * running. That last one is the difference between a useful error and a timeout: most of the studio
 * works perfectly well with Minecraft closed, and the parts that do not should say so immediately.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import * as docs from './docs.mjs';
import * as jobs from './jobs.mjs';
import * as director from './director.mjs';
import * as projects from './project.mjs';
import * as pipeline from './pipeline.mjs';
import * as schematic from './schematic.mjs';
import * as snapshot from './snapshot.mjs';
import * as bundle from './bundle.mjs';
import * as narration from './narration.mjs';
import * as tracks from './tracks.mjs';
import * as placements from './placements.mjs';
import { parseSelector, resolveSelector, resolveTimeline, describeSelector } from './selector.mjs';
import { resolve as resolvePath, relative as relativePath } from './paths.mjs';
import { voiceDir, AUDITION_VOICES, pauses, subtitlesFor } from '../../tools/render-voice.mjs';
import { aim } from '../../tools/aim.mjs';
import {
  bounds, occupancy, visibility, moveFor, bestBearing, vantages, insideMove,
  aimTarget, placementShots, waterReach, samplePath, curveClear,
} from '../../tools/frame-parts.mjs';

/* ── little helpers ─────────────────────────────────────────────────────────────────────────── */

const str = (describe) => ({ type: 'string', description: describe });
const num = (describe) => ({ type: 'number', description: describe });
const bool = (describe) => ({ type: 'boolean', description: describe });
const arr = (items, describe) => ({ type: 'array', items, description: describe });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const free = (describe) => ({ type: 'object', description: describe, additionalProperties: true });
const nothing = obj({});

const slugArg = { slug: str('Which project. Defaults to the only one, if there is only one.') };

/** The project a call is about: named, or the obvious one. */
async function projectFor(params = {}) {
  if (params.project) return params.project;
  const { projects: found, adoptable } = await projects.discover();
  if (params.slug) return projects.open(params.slug);
  if (found.length === 1) return found[0];
  if (found.length === 0 && adoptable.length === 1) return projects.open(adoptable[0].slug);
  throw new Error(`say which project: ${[...found.map((p) => p.slug), ...adoptable.map((a) => a.slug)].join(', ')}`);
}

/** The geometry a camera solver needs: parts, occupancy, and where the water will get to. */
async function geometryFor(project) {
  if (!project.derived?.groups) throw new Error(`${project.slug} has no resolved parts file`);
  const { value: groups } = await docs.readJson(project.derived.groups);
  const origin = project.origin ?? [0, 0, 0];
  const occupied = occupancy(groups, origin);
  const wet = waterReach(groups, origin);
  return { groups, origin, occupied, wet, blocked: new Set([...occupied, ...wet]) };
}

/** Positions of one part in world coordinates. */
function worldPositions(groups, name, origin) {
  const positions = groups.parts?.[name];
  if (!positions) throw new Error(`no part named "${name}" — the manifest has ${Object.keys(groups.parts ?? {}).join(', ')}`);
  return positions.map((p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]);
}

/* ── the table ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A storyboard with everything resolved against the episode: which millisecond each cue lands on,
 * and which blocks a placement claims.
 *
 * Shared by `cues_list` and `timeline_track` rather than written twice — a second copy is where a
 * list and a picture start disagreeing about the same document.
 */
async function storyboardOf(project) {
  const { value: storyboard } = await docs.readJson(project.documents.storyboard);
  const beats = await pipeline.beats(project.documents.beats);
  const byId = new Map(beats.beats.map((b) => [b.id, b]));
  let resolved = null;
  if (project.derived?.schematic) {
    const blocks = await schematic.load(project.derived.schematic);
    const parts = project.derived.groups
      ? (await schematic.groups(project.derived.groups, project.derived.schematic)).parts : {};
    resolved = resolveTimeline(storyboard.cues ?? [], { blockList: blocks.blockList, parts });
  }
  const cues = (storyboard.cues ?? []).map((cue, index) => {
    const beat = cue.beat ? byId.get(cue.beat) : null;
    const place = resolved?.perCue.find((p) => p.cue === index);
    return {
      index,
      ...cue,
      atMsResolved: cue.atMs ?? (beat && typeof beat.startMs === 'number' && typeof cue.at === 'number'
        ? Math.round(beat.startMs + cue.at * beat.measuredMs) : null),
      blocksResolved: place ? { count: place.indices.length, describe: place.describe, error: place.error } : undefined,
    };
  });
  const placedByCue = {};
  for (const place of resolved?.perCue ?? []) placedByCue[place.cue] = place.indices;
  return {
    path: project.documents.storyboard,
    take: storyboard.take,
    beats: beats.beats,
    cues,
    placedByCue,
    unplaced: resolved ? resolved.unplaced.length : null,
    unplacedByType: resolved ? resolved.unplacedByType : null,
  };
}

export const ops = {

  /* ── projects ─────────────────────────────────────────────────────────────────────────────── */

  project_list: {
    group: 'project',
    describe: 'Every project in the repository, and every episode that could become one.',
    input: nothing,
    sideEffects: 'none',
    async run() {
      const { projects: found, adoptable } = await projects.discover();
      return {
        projects: found.map((p) => ({
          slug: p.slug, name: p.name, world: p.world, origin: p.origin,
          takes: p.takes.map((t) => t.name), manifest: p.manifest,
        })),
        adoptable,
      };
    },
  },

  project_open: {
    group: 'project',
    describe: 'One project in full: its documents, its takes, what it needs. Adopts an existing '
      + 'episode into a project the first time it is opened.',
    input: obj({ slug: str('The project, e.g. "ore-plant"') }, ['slug']),
    sideEffects: 'files',
    run: ({ slug }) => projects.open(slug),
  },

  project_adopt: {
    group: 'project',
    describe: 'Writes a project manifest for an episode that already has its files.',
    input: obj({ slug: str('The episode, named after its storyboard'), name: str('A readable title') }, ['slug']),
    sideEffects: 'files',
    run: ({ slug, name }) => projects.adopt(slug, { name }),
  },

  project_save_as: {
    group: 'project',
    describe: 'Duplicates a project under a new slug — a copy to try something in.',
    input: obj({ ...slugArg, as: str('The new slug'), name: str('A readable title') }, ['as']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const exported = await bundle.exportProject(project, { profile: 'source', out: `out/export/.copy-${params.as}.ndproj` });
      const result = await bundle.importProject(exported.path, { as: params.as });
      const copy = await projects.open(params.as);
      if (params.name) await projects.update(copy, [{ op: 'set', pointer: '/name', value: params.name }]);
      return { slug: params.as, files: result.files.length, from: project.slug };
    },
  },

  project_doctor: {
    group: 'project',
    describe: 'Everything wrong with a project right now: missing files, stale derivations, '
      + 'unspoken beats, parts nobody places, mods the running instance does not have.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const status = await pipeline.status(project);
      const findings = [];
      for (const link of status.links) {
        if (link.state === 'fresh') continue;
        findings.push({
          level: link.state === 'missing' ? 'error' : link.state === 'stale' ? 'error' : 'warning',
          text: link.why,
          fix: link.fix,
        });
      }
      if (status.narration && !status.narration.measured) {
        const unspoken = status.narration.beats.filter((b) => b.state !== 'fresh');
        findings.push({
          level: 'error',
          text: `${unspoken.length} of ${status.narration.beats.length} beats have not been spoken as they now read`,
          fix: { command: 'voice-render', params: {} },
        });
      }
      for (const note of status.notes) findings.push(note);

      // What no cue places — the same warning the director logs when a take is submitted.
      if (project.documents?.storyboard && project.derived?.schematic) {
        try {
          const { value: storyboard } = await docs.readJson(project.documents.storyboard);
          const blocks = await schematic.load(project.derived.schematic);
          const parts = project.derived.groups
            ? (await schematic.groups(project.derived.groups, project.derived.schematic)).parts : {};
          const resolved = resolveTimeline(storyboard.cues ?? [], { blockList: blocks.blockList, parts });
          if (resolved.unplaced.length) {
            findings.push({
              level: 'error',
              text: `${resolved.unplaced.length} blocks are in the schematic but no cue places them: `
                + Object.entries(resolved.unplacedByType).map(([id, n]) => `${id} ×${n}`).join(', '),
            });
          }
          for (const cue of resolved.perCue) {
            if (cue.error) findings.push({ level: 'error', text: `cue ${cue.cue}: ${cue.error}` });
          }
        } catch (error) {
          findings.push({ level: 'warning', text: `the storyboard could not be resolved: ${error.message}` });
        }
      }

      // Mods, asked of the instance if it is up.
      const wanted = project.requires?.mods ?? [];
      const game = await director.status();
      if (game.up && project.derived?.schematic) {
        try {
          const colors = await director.blockColors();
          const known = new Set(Object.keys(colors).map((id) => id.split(':')[0]));
          const missing = wanted.filter((mod) => !known.has(mod));
          if (missing.length) {
            findings.push({
              level: 'error',
              text: `the running instance does not have ${missing.join(', ')} — every block of those `
                + 'mods will be read as air and vanish from the build without a word',
            });
          }
        } catch {
          // An older mod without /blockcolors. Not worth a finding of its own.
        }
      }
      return { slug: project.slug, ok: findings.every((f) => f.level !== 'error'), findings, pipeline: status };
    },
  },

  pipeline_status: {
    group: 'project',
    describe: 'The derivation chain: what follows what, what is stale, and the command that fixes it.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      return pipeline.status(await projectFor(params));
    },
  },

  project_snapshot: {
    group: 'project',
    describe: 'Takes a labelled copy of everything authored, to come back to.',
    input: obj({ ...slugArg, label: str('What to call it') }),
    sideEffects: 'files',
    async run(params) {
      return snapshot.create(await projectFor(params), { label: params.label ?? 'snapshot' });
    },
  },

  project_snapshots: {
    group: 'project',
    describe: 'Every snapshot of a project, newest first.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      return { slug: project.slug, snapshots: await snapshot.list(project.slug) };
    },
  },

  project_restore: {
    group: 'project',
    describe: 'Puts a snapshot back — taking one of the current state first. With dryRun, only says what would change.',
    input: obj({ ...slugArg, id: str('The snapshot id'), dryRun: bool('Only report the difference') }, ['id']),
    sideEffects: 'files',
    async run(params) {
      return snapshot.restore(await projectFor(params), params.id, { dryRun: params.dryRun ?? false });
    },
  },

  project_export: {
    group: 'project',
    describe: 'Writes the project as one .ndproj file: source, full or delivery.',
    input: obj({
      ...slugArg,
      profile: { type: 'string', enum: bundle.PROFILES, description: 'source keeps documents and alignments; full adds audio and snapshots; delivery is the video and its subtitles' },
      out: str('Where to write it'),
    }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      return bundle.exportProject(project, { profile: params.profile ?? 'source', out: params.out });
    },
  },

  project_import: {
    group: 'project',
    describe: 'Unpacks a .ndproj into the repository, checking its hashes and what it needs first.',
    input: obj({
      file: str('The .ndproj to import'),
      as: str('Import under a different slug'),
      force: bool('Write over an existing project (a snapshot is taken first)'),
    }, ['file']),
    sideEffects: 'files',
    async run({ file, as, force }) {
      const result = await bundle.importProject(file, { as, force });
      const project = await projects.open(result.slug);
      const doctor = await ops.project_doctor.run({ project });
      return { ...result, doctor };
    },
  },

  project_inspect_bundle: {
    group: 'project',
    describe: 'What is inside a .ndproj, without unpacking it.',
    input: obj({ file: str('The .ndproj') }, ['file']),
    sideEffects: 'none',
    async run({ file }) {
      const { manifest, entries, damaged } = await bundle.inspect(file);
      return { manifest, entries, damaged };
    },
  },

  /* ── documents ────────────────────────────────────────────────────────────────────────────── */

  doc_read: {
    group: 'documents',
    describe: 'A document, as text and as a value.',
    input: obj({
      path: str('Repository-relative path'),
      pointer: str('A JSON pointer, to read one field'),
      optional: bool('True for a document that may legitimately not exist yet, such as a cache — '
        + 'missing then reads as a null value rather than as a failure'),
    }, ['path']),
    sideEffects: 'none',
    async run({ path: file, pointer, optional }) {
      if (optional) {
        const present = await docs.readJsonIfPresent(file);
        return present ?? { path: file, missing: true, value: null };
      }
      if (pointer) return { path: file, pointer, value: await docs.readPointer(file, pointer) };
      const { text, modified } = await docs.readText(file);
      const value = file.endsWith('.json') ? JSON.parse(text) : undefined;
      return { path: file, text, value, modified };
    },
  },

  doc_write: {
    group: 'documents',
    describe: 'Replaces a document wholesale. For prose; structured changes should use doc_patch.',
    input: obj({ path: str('Repository-relative path'), text: str('The new contents') }, ['path', 'text']),
    sideEffects: 'files',
    run: ({ path: file, text }) => docs.writeText(file, text),
  },

  doc_patch: {
    group: 'documents',
    describe: 'Changes named fields of a JSON document and leaves every other byte alone — comments, '
      + 'key order and formatting included. Ops are {op: replace|set|add|remove, pointer, value, index}.',
    input: obj({
      path: str('Repository-relative path'),
      ops: arr(free('One edit'), 'The edits, applied in order'),
      expectModified: num('The mtime you last read, to refuse a write over somebody else\'s change'),
    }, ['path', 'ops']),
    sideEffects: 'files',
    run: ({ path: file, ops: edits, expectModified }) => docs.patchJson(file, edits, { expectModified }),
  },

  doc_diff: {
    group: 'documents',
    describe: 'Line differences between a document and some other text.',
    input: obj({ path: str('Repository-relative path'), text: str('What to compare against') }, ['path', 'text']),
    sideEffects: 'none',
    async run({ path: file, text }) {
      const current = await docs.readText(file);
      return { path: file, changes: docs.diffLines(current.text, text) };
    },
  },

  /* ── narration ────────────────────────────────────────────────────────────────────────────── */

  beats_read: {
    group: 'narration',
    describe: 'The beats, with what was measured and which of them have been rewritten since they were spoken.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const { value } = await docs.readJson(project.documents.beats);
      const state = await pipeline.beats(project.documents.beats);
      return {
        path: project.documents.beats,
        voiceId: value.voiceId,
        voiceName: value.voiceName,
        totalMs: value.totalMs ?? null,
        beats: value.beats.map((beat) => ({
          ...beat,
          state: state.beats.find((b) => b.id === beat.id)?.state ?? 'missing',
          why: state.beats.find((b) => b.id === beat.id)?.why,
        })),
      };
    },
  },

  beat_set: {
    group: 'narration',
    describe: 'Rewrites one beat: its text, its estimate, or both. Measured values are left alone — '
      + 'only speaking the beat may change those.',
    input: obj({
      ...slugArg,
      id: str('The beat, e.g. "b3"'),
      text: str('The new narration'),
      plannedMs: num('The estimate, before it is measured'),
    }, ['id']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const file = project.documents.beats;
      const { value } = await docs.readJson(file);
      const index = (value.beats ?? []).findIndex((b) => b.id === params.id);
      if (index === -1) throw new Error(`no beat ${params.id} in ${file}`);
      const edits = [];
      if (params.text !== undefined) edits.push({ op: 'replace', pointer: `/beats/${index}/text`, value: params.text });
      if (params.plannedMs !== undefined) edits.push({ op: 'set', pointer: `/beats/${index}/plannedMs`, value: params.plannedMs });
      if (!edits.length) throw new Error('nothing to change — pass text or plannedMs');
      const result = await docs.patchJson(file, edits);
      return { path: file, id: params.id, changed: result.changed, beat: result.value.beats[index] };
    },
  },

  voice_render: {
    group: 'narration',
    describe: 'Speaks the beats and measures them. Naming one beat re-speaks only that one and '
      + 'rebuilds every offset and the subtitles around it. Takes a snapshot first, because this '
      + 'rewrites measurements that cannot be typed back.',
    input: obj({ ...slugArg, beat: str('One beat id, or leave out for all of them'), wait: bool('Block until it finishes') }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      await snapshot.create(project, { label: `before-render-${params.beat ?? 'all'}`, reason: 'automatic, before speaking' });
      const job = jobs.start('voice-render', { beats: project.documents.beats, beat: params.beat },
        { label: `speak ${params.beat ?? 'every beat'}` });
      if (params.wait === false) return { job: job.id, running: true };
      const result = await jobs.waitFor(job);
      return { job: job.id, exitCode: result.exitCode, lines: result.lines };
    },
  },

  voice_audition: {
    group: 'narration',
    describe: 'Speaks one beat in every audition voice, so they can be compared on real material.',
    input: obj({ ...slugArg, beat: str('Which beat') }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const job = jobs.start('voice-audition', { beats: project.documents.beats, beat: params.beat ?? 'b0' });
      const result = await jobs.waitFor(job);
      return { job: job.id, exitCode: result.exitCode, voices: AUDITION_VOICES, lines: result.lines };
    },
  },

  voice_pauses: {
    group: 'narration',
    describe: 'Where the voice actually paused in a spoken beat, and for how long — the phrasing, measured.',
    input: obj({ ...slugArg, beat: str('Which beat'), minMs: num('Ignore pauses shorter than this') }, ['beat']),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const dir = voiceDir(project.documents.beats);
      const alignment = await docs.readJsonIfPresent(`${dir}/${params.beat}.alignment.json`);
      if (!alignment) throw new Error(`${params.beat} has not been spoken yet`);
      return {
        beat: params.beat,
        text: alignment.value.characters.join(''),
        pauses: pauses(alignment.value, { minMs: params.minMs ?? 300 }),
      };
    },
  },

  subtitles_build: {
    group: 'narration',
    describe: 'Rebuilds the subtitle track from the alignments already on disk — no key, no '
      + 'network, no re-rendering. What to run after a subtitle file has been found wanting.',
    input: obj({ ...slugArg }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const { value: beats } = await docs.readJson(project.documents.beats);
      const dir = voiceDir(project.documents.beats);
      // Absolute, because the studio's working directory is wherever it was started from while a
      // tool run from the command line has the repository root under its feet.
      const { srt, totalMs } = await subtitlesFor(beats, resolvePath(dir));
      const file = `${dir}/subtitles.srt`;
      await docs.writeGenerated(file, srt);
      return { path: file, cues: srt.split('\n\n').filter((block) => block.trim()).length, totalMs };
    },
  },

  narration_track: {
    group: 'narration',
    describe: 'Every sentence of the episode with the millisecond it is spoken, taken from the '
      + 'alignments — the same lines, at the same times, as the subtitle track.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      return narration.track(project.documents.beats);
    },
  },

  subtitles_read: {
    group: 'narration',
    describe: 'The subtitle track built from the alignments.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const file = `${voiceDir(project.documents.beats)}/subtitles.srt`;
      const { text } = await docs.readText(file);
      return { path: file, srt: text };
    },
  },

  /* ── storyboard and timeline ──────────────────────────────────────────────────────────────── */

  cues_list: {
    group: 'storyboard',
    describe: 'The cues of a storyboard, each with what it resolves to: which beat and millisecond, '
      + 'and for a place cue, which blocks.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      return storyboardOf(await projectFor(params));
    },
  },

  timeline_track: {
    group: 'storyboard',
    describe: 'The episode as four lanes on one clock: the sentences being spoken, the camera '
      + 'moves, what is being built, and what happens to the world — each with the millisecond it '
      + 'starts and how long it lasts.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const board = await storyboardOf(project);
      const sentences = await narration.track(project.documents.beats);
      return {
        path: project.documents.storyboard,
        take: board.take,
        ...tracks.lanes({ cues: board.cues, beats: board.beats, sentences }),
        unplaced: board.unplaced,
        unplacedByType: board.unplacedByType,
      };
    },
  },

  placement_times: {
    group: 'storyboard',
    describe: 'When each block of the build appears, in milliseconds of the episode — the '
      + 'director\'s own spreading arithmetic, so a playhead can show the build going up without '
      + 'the game being open.',
    input: obj({ ...slugArg, take: str('A compiled take, rather than the storyboard it came from') }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const blocks = await schematic.load(project.derived.schematic);

      // A take is what actually gets recorded and scrubbed, and its cues carry absolute
      // milliseconds; the storyboard carries fractions of a beat. Both resolve to the same shape.
      if (params.take) {
        const take = projects.takeNamed(project, params.take);
        const { value: timeline } = await docs.readJson(take.out);
        const parts = project.derived.groups
          ? (await schematic.groups(project.derived.groups, project.derived.schematic)).parts : {};
        const resolved = resolveTimeline(timeline.cues ?? [], { blockList: blocks.blockList, parts });
        const placedByCue = {};
        for (const place of resolved.perCue) placedByCue[place.cue] = place.indices;
        return {
          take: take.name,
          ...placements.times({
            cues: (timeline.cues ?? []).map((cue, index) => ({ ...cue, index, atMsResolved: cue.atMs ?? null })),
            placedByCue,
            blocks: blocks.blockList,
          }),
        };
      }

      const board = await storyboardOf(project);
      return placements.times({
        cues: board.cues,
        placedByCue: board.placedByCue,
        blocks: blocks.blockList,
      });
    },
  },

  cue_add: {
    group: 'storyboard',
    describe: 'Adds a cue to the storyboard.',
    input: obj({ ...slugArg, cue: free('The cue, as it is written in the storyboard'), index: num('Where to put it') }, ['cue']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const result = await docs.patchJson(project.documents.storyboard,
        [{ op: 'add', pointer: '/cues', value: params.cue, index: params.index }]);
      return { path: result.path, cues: result.value.cues.length };
    },
  },

  cue_update: {
    group: 'storyboard',
    describe: 'Changes fields of one cue, leaving the rest of the document exactly as it was.',
    input: obj({ ...slugArg, index: num('Which cue'), fields: free('The fields to set; null removes one') }, ['index', 'fields']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const edits = Object.entries(params.fields).map(([key, value]) => (value === null
        ? { op: 'remove', pointer: `/cues/${params.index}/${key}` }
        : { op: 'set', pointer: `/cues/${params.index}/${key}`, value }));
      const result = await docs.patchJson(project.documents.storyboard, edits);
      return { path: result.path, cue: result.value.cues[params.index] };
    },
  },

  cue_move: {
    group: 'storyboard',
    describe: 'Moves a cue in time: to another beat, or to another fraction of the one it is in. '
      + 'Fractions, not milliseconds — that is what survives a beat being re-spoken.',
    input: obj({ ...slugArg, index: num('Which cue'), beat: str('The beat it should sit in'), at: num('Where inside it, 0..1'), until: num('For a camera cue, where it ends') }, ['index']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const edits = [];
      if (params.beat !== undefined) edits.push({ op: 'set', pointer: `/cues/${params.index}/beat`, value: params.beat });
      if (params.at !== undefined) {
        if (params.at < 0 || params.at > 1) throw new Error('at is a fraction of a beat, between 0 and 1');
        edits.push({ op: 'set', pointer: `/cues/${params.index}/at`, value: params.at });
      }
      if (params.until !== undefined) edits.push({ op: 'set', pointer: `/cues/${params.index}/until`, value: params.until });
      if (!edits.length) throw new Error('nothing to move — pass beat, at or until');
      const result = await docs.patchJson(project.documents.storyboard, edits);
      return { path: result.path, cue: result.value.cues[params.index] };
    },
  },

  cue_delete: {
    group: 'storyboard',
    describe: 'Removes a cue from the storyboard. The blocks it placed become unclaimed, which the '
      + 'doctor will say out loud rather than letting them quietly never be built.',
    input: obj({ ...slugArg, index: num('Which cue') }, ['index']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const result = await docs.patchJson(project.documents.storyboard, [{ op: 'remove', pointer: `/cues/${params.index}` }]);
      return { path: result.path, cues: result.value.cues.length };
    },
  },

  storyboard_check: {
    group: 'storyboard',
    describe: 'Checks a storyboard against its schematic before anything is rendered: filters on '
      + 'blocks that have none, fills aimed at things that are not containers, parts nobody places.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const job = jobs.start('check-storyboard', { storyboard: project.documents.storyboard });
      const result = await jobs.waitFor(job);
      return { ok: result.exitCode === 0, lines: result.lines };
    },
  },

  timeline_compile: {
    group: 'storyboard',
    describe: 'Resolves the storyboard against the measured narration into a runnable timeline.',
    input: obj({ ...slugArg, out: str('Where to write it') }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const out = params.out ?? projects.takeNamed(project, 'episode').out ?? `script/${project.slug}.json`;
      const result = await jobs.run('make-timeline', { storyboard: project.documents.storyboard, out });
      return { out, lines: result.lines };
    },
  },

  /* ── camera ───────────────────────────────────────────────────────────────────────────────── */

  camera_aim: {
    group: 'camera',
    describe: 'The yaw and pitch that point from one place at another.',
    input: obj({ from: arr(num(), 'x, y, z'), to: arr(num(), 'x, y, z') }, ['from', 'to']),
    sideEffects: 'none',
    run: ({ from, to }) => aim(from, to),
  },

  camera_solve: {
    group: 'camera',
    describe: 'Proposes a camera move for a part: an arc past it, a vantage inside it, or the list '
      + 'of places it can be seen from at all. This is the arc style — for the follow style, use '
      + 'placement_shots.',
    input: obj({
      ...slugArg,
      part: str('Which assembly'),
      style: { type: 'string', enum: ['arc', 'inside', 'vantages'], description: 'How to look at it' },
      bearing: num('Where the camera stands, Minecraft yaw: 0 is south, 90 is west'),
      lift: num('How far above eye level to start'),
      search: bool('Let the solver move the bearing if the part is buried from the one asked for'),
      lookAt: arr(str(), 'For the inside style: the parts to aim at, if not the one stood in'),
    }, ['part']),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const { groups, origin, occupied, blocked } = await geometryFor(project);
      const positions = groups.parts[params.part];
      if (!positions) throw new Error(`no part named "${params.part}"`);
      const { lo, size } = bounds(positions);
      const targets = worldPositions(groups, params.part, origin);

      if ((params.style ?? 'arc') === 'arc') {
        let bearing = params.bearing ?? 215;
        let lift = params.lift ?? 0;
        let searched = null;
        if (params.search) {
          searched = bestBearing(lo, size, origin, bearing, occupied, positions);
          bearing = searched.bearing;
          lift = searched.lift;
        }
        const keyframes = moveFor(lo, size, origin, bearing, occupied, lift);
        return {
          part: params.part, style: 'arc', bearing, lift, searched,
          keyframes,
          visibility: visibility(keyframes[keyframes.length - 1].pos, targets, occupied),
          clear: curveClear(keyframes, blocked),
        };
      }
      if (params.style === 'inside') {
        const lookAt = (params.lookAt ?? [params.part]).flatMap((name) => worldPositions(groups, name, origin));
        const keyframes = insideMove(targets, blocked, { lookAt });
        return {
          part: params.part, style: 'inside', keyframes,
          visibility: visibility(keyframes[keyframes.length - 1].pos, lookAt, occupied),
          clear: curveClear(keyframes, blocked),
        };
      }
      const found = vantages(targets, blocked, {});
      return { part: params.part, style: 'vantages', centre: found.centre, vantages: found.vantages.slice(0, 40) };
    },
  },

  placement_shots: {
    group: 'camera',
    describe: 'The follow style, block by block: where the camera stands for each placement, which '
      + 'face it points at, and the two things worth knowing — a cut, where it cannot glide there '
      + 'calmly, and blind, where nowhere can see the block at all.',
    input: obj({
      ...slugArg,
      part: str('Which assembly'),
      near: num('Closest the camera may stand'),
      far: num('Furthest it may stand'),
      ideal: num('The distance it prefers'),
      glide: num('How far it may drift between two blocks without cutting'),
      alreadyPlaced: arr(str(), 'Parts that are already standing when this one starts'),
    }, ['part']),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const { groups, origin, blocked } = await geometryFor(project);
      const positions = groups.parts[params.part];
      if (!positions) throw new Error(`no part named "${params.part}"`);
      // Rays are cast against the build as it stands at that moment, so what came earlier matters.
      const placed = new Set();
      for (const name of params.alreadyPlaced ?? []) {
        for (const pos of worldPositions(groups, name, origin)) placed.add(pos.join(','));
      }
      const shots = placementShots(positions, placed, origin, {
        near: params.near, far: params.far, ideal: params.ideal, glide: params.glide, neverStand: blocked,
      });
      return {
        part: params.part,
        blocks: shots.length,
        cuts: shots.filter((s) => s.cut).length,
        blind: shots.filter((s) => s.blind).map((s) => s.index),
        shots,
      };
    },
  },

  water_reach: {
    group: 'camera',
    describe: 'Where the water in a build will have flowed to — the schematic only carries the '
      + 'sources, and the camera may not stand in the rest.',
    input: obj({ ...slugArg, spread: num('How far a source may reach') }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const { groups, origin } = await geometryFor(project);
      const wet = waterReach(groups, origin, params.spread ? { spread: params.spread } : {});
      return { positions: [...wet].map((k) => k.split(',').map(Number)), count: wet.size };
    },
  },

  camera_path: {
    group: 'camera',
    describe: 'Samples a camera move along the curve the game will fly, with clearance per sample. '
      + 'Asks the director when it is up, so the answer comes from the same code that flies it.',
    input: obj({
      ...slugArg,
      keyframes: arr(free('pos, yaw, pitch'), 'The keyframes'),
      durationMs: num('How long the move takes'),
      ease: { type: 'string', enum: ['inOut', 'linear'], description: 'inOut settles at both ends; linear is for one leg of a longer journey' },
      samples: num('How many points along the curve'),
    }, ['keyframes']),
    sideEffects: 'none',
    async run(params) {
      const game = await director.status();
      if (game.up) {
        try {
          return { source: 'director', ...await director.path(params) };
        } catch (error) {
          if (error.code !== 'DIRECTOR_DOWN') throw error;
        }
      }
      const project = await projectFor(params).catch(() => null);
      const blocked = project ? (await geometryFor(project)).blocked : new Set();
      const count = params.samples ?? 240;
      const ease = params.ease === 'linear' ? (t) => t : (t) => t * t * (3 - 2 * t);
      const samples = [];
      for (let i = 0; i <= count; i++) {
        const t = i / count;
        const pos = samplePath(params.keyframes, ease(t));
        samples.push({ t, pos, blocked: blocked.has(pos.map(Math.floor).join(',')) });
      }
      return {
        source: 'studio',
        samples,
        blockedSamples: samples.filter((s) => s.blocked).length,
        clear: curveClear(params.keyframes, blocked),
      };
    },
  },

  camera_set: {
    group: 'camera',
    describe: 'Puts the camera in the running game somewhere, now — or flies it there.',
    input: obj({
      pos: arr(num(), 'x, y, z of the eye'),
      yaw: num('0 is south, 90 is west'),
      pitch: num('Positive looks down'),
      durationMs: num('Fly rather than jump'),
    }, ['pos']),
    sideEffects: 'world',
    needsDirector: true,
    run: (params) => director.camera(params),
  },

  camera_drift: {
    group: 'camera',
    describe: 'Flies a take and measures how far the camera strayed from the curve it was given.',
    input: obj({ timeline: str('The timeline to fly') }, ['timeline']),
    sideEffects: 'world',
    needsDirector: true,
    async run({ timeline }) {
      const result = await jobs.run('camera-drift', { timeline });
      return { lines: result.lines };
    },
  },

  pose_get: {
    group: 'camera',
    describe: 'Where the camera is and what it is looking at, for turning a stance into a keyframe.',
    input: nothing,
    sideEffects: 'none',
    needsDirector: true,
    run: () => director.pose(),
  },

  look_get: {
    group: 'camera',
    describe: 'The block the player is looking at, with its index in the schematic and the part it '
      + 'belongs to — so a target can be pointed at rather than typed.',
    input: obj({ ...slugArg, maxDistance: num('How far to reach') }),
    sideEffects: 'none',
    needsDirector: true,
    async run(params) {
      const hit = await director.look({ maxDistance: params.maxDistance });
      if (!hit.hit) return hit;
      // The game says where and what; which block of the schematic that is, is arithmetic the
      // studio already has everything for.
      const project = await projectFor(params).catch(() => null);
      if (!project?.derived?.schematic) return hit;
      const origin = project.origin ?? [0, 0, 0];
      const local = hit.pos.map((n, i) => n - origin[i]);
      const blocks = await schematic.load(project.derived.schematic);
      const found = blocks.blockList.find((b) => b.pos[0] === local[0] && b.pos[1] === local[1] && b.pos[2] === local[2]);
      let part = null;
      if (project.derived.groups && found) {
        const resolved = await schematic.groups(project.derived.groups, project.derived.schematic);
        part = Object.entries(resolved.parts).find(([, indices]) => indices.includes(found.i))?.[0] ?? null;
      }
      return { ...hit, local, schematicIndex: found?.i ?? null, inSchematic: Boolean(found), part };
    },
  },

  /* ── schematic and parts ──────────────────────────────────────────────────────────────────── */

  schematic_blocks: {
    group: 'schematic',
    describe: 'The schematic as a block list, in the order the director counts — which is what a '
      + 'cue means by an index.',
    input: obj({ ...slugArg, file: str('A schematic, if not the project\'s'), summary: bool('Counts only') }),
    sideEffects: 'none',
    async run(params) {
      const file = params.file ?? (await projectFor(params)).derived.schematic;
      return params.summary ? schematic.summary(file) : schematic.load(file);
    },
  },

  block_appearance: {
    group: 'schematic',
    describe: 'Asks the running instance what the blocks of this build look like — the colour the '
      + 'map would paint each one, and their actual top, side and bottom faces packed into a small '
      + 'atlas — and caches both so the viewport keeps them after the game is closed.',
    input: obj({ ...slugArg, coloursOnly: bool('Skip the textures and refresh only the colours') }),
    sideEffects: 'files',
    needsDirector: true,
    async run(params) {
      const project = await projectFor(params);
      const summary = await schematic.summary(project.derived.schematic);
      const ids = Object.keys(summary.types);

      // Colours first, and for every block rather than only these: the doctor reads the same file
      // to tell whether the instance has Create loaded at all, and that question is about the
      // registry, not about this contraption.
      const colours = await director.blockColors();
      await docs.writeGenerated('studio/blockcolors.json', JSON.stringify(colours, null, 0) + '\n');
      if (params.coloursOnly) {
        return { colours: Object.keys(colours).length, textures: null };
      }

      const atlas = await director.blockTextures(ids);
      // The atlas travels inside its own index as a data URL. One file to cache, one file to read,
      // and no second route to serve a picture that is thirty kilobytes long.
      const cache = {
        schematic: project.derived.schematic,
        tile: atlas.tile,
        columns: atlas.columns,
        rows: atlas.rows,
        blocks: atlas.blocks,
        missing: atlas.missing,
        // Blocks the game draws with nothing at all — Create's crushing wheel controller is a
        // block of behaviour with no model. Carried so the viewport's map-colour fallback is a
        // documented choice rather than a mystery.
        untextured: atlas.untextured ?? [],
        atlas: `data:image/png;base64,${atlas.png}`,
      };
      const file = `studio/blocktextures/${project.slug}.json`;
      await docs.writeGenerated(file, JSON.stringify(cache) + '\n');
      return {
        path: file,
        colours: Object.keys(colours).length,
        types: ids.length,
        tiles: atlas.tiles,
        missing: atlas.missing,
        untextured: atlas.untextured ?? [],
      };
    },
  },

  schematic_report: {
    group: 'schematic',
    describe: 'The census written when the build was cut out of the world, and whether it still '
      + 'describes the schematic beside it.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const file = project.derived.schematic.replace(/\.nbt$/, '.report.json');
      const report = await docs.readJsonIfPresent(file);
      if (!report) return { path: file, present: false };
      const now = await schematic.summary(project.derived.schematic);
      return {
        path: file,
        present: true,
        report: report.value,
        blocksNow: now.blocks,
        stale: report.value.blocks !== now.blocks,
      };
    },
  },

  parts_read: {
    group: 'schematic',
    describe: 'The parts manifest — the rules — and what they last resolved to.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const manifest = await docs.readJson(project.documents.partsManifest);
      const resolved = project.derived.groups
        ? await schematic.groups(project.derived.groups, project.derived.schematic) : null;
      return {
        path: project.documents.partsManifest,
        manifest: manifest.value,
        resolved: resolved && {
          blocks: resolved.blocks,
          stale: resolved.stale,
          counts: Object.fromEntries(Object.entries(resolved.parts).map(([k, v]) => [k, v.length])),
        },
      };
    },
  },

  parts_write: {
    group: 'schematic',
    describe: 'Changes the parts manifest and resolves it again. A block belonging to no part is a '
      + 'failure, not a warning — it would be a block no beat ever builds.',
    input: obj({ ...slugArg, ops: arr(free('An edit'), 'Edits to the manifest'), resolve: bool('Run parts.py afterwards') }, ['ops']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const patched = await docs.patchJson(project.documents.partsManifest, params.ops);
      if (params.resolve === false) return { ...patched, resolved: null };
      const job = jobs.start('parts', {
        schematic: project.derived.schematic,
        manifest: project.documents.partsManifest,
        json: project.derived.groups,
      });
      const result = await jobs.waitFor(job);
      schematic.forget();
      return { path: patched.path, ok: result.exitCode === 0, lines: result.lines };
    },
  },

  parts_resolve: {
    group: 'schematic',
    describe: 'Resolves the manifest into positions, and says what it missed.',
    input: obj({ ...slugArg, map: bool('Also draw the plan view') }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const job = jobs.start('parts', {
        schematic: project.derived.schematic,
        manifest: project.documents.partsManifest,
        json: project.derived.groups,
        map: params.map,
      });
      const result = await jobs.waitFor(job);
      schematic.forget();
      return { ok: result.exitCode === 0, lines: result.lines };
    },
  },

  selector_resolve: {
    group: 'schematic',
    describe: 'Which blocks a place cue names. Resolved the way the director does it — in cue '
      + 'order against one shared set of claims, so "rest" means what it will mean on the night.',
    input: obj({
      ...slugArg,
      blocks: { description: 'A selector: indices, "all", "rest", {from,to}, {ofType}, {part}, {rest,except}' },
      upToCue: num('Resolve the storyboard\'s cues before this one first, so rest is honest'),
    }, ['blocks']),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const blocks = await schematic.load(project.derived.schematic);
      const parts = project.derived.groups
        ? (await schematic.groups(project.derived.groups, project.derived.schematic)).parts : {};
      const claimed = new Set();
      if (params.upToCue !== undefined) {
        const { value: storyboard } = await docs.readJson(project.documents.storyboard);
        const earlier = (storyboard.cues ?? []).slice(0, params.upToCue);
        resolveTimeline(earlier, { blockList: blocks.blockList, parts }).perCue
          .forEach((cue) => cue.indices.forEach((i) => claimed.add(i)));
      }
      const selector = parseSelector(params.blocks);
      const indices = resolveSelector(selector, { blockList: blocks.blockList, parts }, claimed);
      return {
        describe: describeSelector(selector),
        count: indices.length,
        indices,
        blocks: indices.slice(0, 400).map((i) => ({ i, ...blocks.blockList[i] })),
      };
    },
  },

  clip_run: {
    group: 'schematic',
    describe: 'Cuts the build out of a saved world again, from its clip spec. Takes a snapshot '
      + 'first: a re-cut renumbers everything the parts file and the cues point at.',
    input: obj({ ...slugArg, dryRun: bool('Only report what it would take') }),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      if (!params.dryRun) {
        await snapshot.create(project, { label: 'before-clip', reason: 'automatic, before re-cutting the schematic' });
      }
      const result = await jobs.run('world-clip', { spec: project.documents.clip, dryRun: params.dryRun });
      schematic.forget();
      return { lines: result.lines };
    },
  },

  world_pull: {
    group: 'schematic',
    describe: 'Fetches the region and entity files around a coordinate off the server.',
    input: obj({ x: num('Block x'), z: num('Block z'), radius: num('In regions'), dest: str('Where to put them') }, ['x', 'z']),
    sideEffects: 'files',
    async run(params) {
      const result = await jobs.run('world-pull', params);
      return { lines: result.lines };
    },
  },

  schematic_edit: {
    group: 'schematic',
    describe: 'Replays the recorded edits against an untouched export.',
    input: obj({ source: str('The untouched export'), edits: str('The edit list'), out: str('Where to write it') }, ['source', 'edits', 'out']),
    sideEffects: 'files',
    async run(params) {
      const result = await jobs.run('schematic-edit', params);
      schematic.forget();
      return { lines: result.lines };
    },
  },

  schematic_install: {
    group: 'schematic',
    describe: 'Copies the schematics and resolved parts into the game\'s own directory. The '
      + 'director reads from there, so an edit that is not installed is an edit that does not happen.',
    input: nothing,
    sideEffects: 'files',
    async run() {
      const result = await jobs.run('gradle', { task: 'installSchematics' });
      return { lines: result.lines.slice(-10) };
    },
  },

  /* ── shots and takes ──────────────────────────────────────────────────────────────────────── */

  shots_read: {
    group: 'shots',
    describe: 'The shot list: the style, bearing and pacing of every assembly, and the stations of '
      + 'the flow take.',
    input: obj({ ...slugArg }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const shots = project.documents.shots ? await docs.readJsonIfPresent(project.documents.shots) : null;
      const stations = project.documents.stations ? await docs.readJsonIfPresent(project.documents.stations) : null;
      return {
        shots: shots && { path: project.documents.shots, ...shots.value },
        stations: stations && { path: project.documents.stations, ...stations.value },
        takes: project.takes,
      };
    },
  },

  shots_write: {
    group: 'shots',
    describe: 'Changes the shot list — a bearing, a lift, a style, the pacing of one assembly.',
    input: obj({ ...slugArg, ops: arr(free('An edit'), 'Edits to the shot list'), which: { type: 'string', enum: ['shots', 'stations'] } }, ['ops']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const file = params.which === 'stations' ? project.documents.stations : project.documents.shots;
      if (!file) throw new Error(`${project.slug} has no ${params.which ?? 'shots'} document yet`);
      return docs.patchJson(file, params.ops);
    },
  },

  take_generate: {
    group: 'shots',
    describe: 'Regenerates one of the project\'s takes from the documents it comes from.',
    input: obj({ ...slugArg, take: str('Which take, e.g. "build-follow"') }, ['take']),
    sideEffects: 'files',
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take);
      const args = take.args ?? {};
      if (take.generator === 'make-timeline') {
        return ops.timeline_compile.run({ project, out: take.out });
      }
      if (take.generator === 'join-takes') {
        const parts = (args.of ?? []).map((name) => projects.takeNamed(project, name).out);
        const result = await jobs.run('join-takes', { takes: parts, gap: args.gap, name: `${project.slug}-${take.name}` });
        await docs.writeGenerated(take.out, result.stdout);
        return { out: take.out, bytes: result.stdout.length, from: parts };
      }
      const params2 = take.generator === 'mk-build-take'
        ? { shots: project.documents.shots, ...args }
        : { stations: project.documents.stations, ...args };
      const result = await jobs.run(take.generator, params2);
      await docs.writeGenerated(take.out, result.stdout);
      return { out: take.out, bytes: result.stdout.length, notes: result.lines.slice(-8) };
    },
  },

  takes_compare: {
    group: 'shots',
    describe: 'Two takes side by side: how many cues, how many keyframes, how long, how many cuts.',
    input: obj({ ...slugArg, takes: arr(str(), 'The take names to compare') }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const names = params.takes ?? project.takes.map((t) => t.name);
      const out = [];
      for (const name of names) {
        const take = projects.takeNamed(project, name);
        const doc = await docs.readJsonIfPresent(take.out);
        if (!doc) {
          out.push({ name, present: false });
          continue;
        }
        const cues = doc.value.cues ?? [];
        const cameras = cues.filter((c) => c.type === 'camera');
        out.push({
          name,
          present: true,
          out: take.out,
          generator: take.generator,
          args: take.args ?? {},
          cues: cues.length,
          cameraCues: cameras.length,
          keyframes: cameras.reduce((n, c) => n + (c.keyframes?.length ?? 0), 0),
          linearCues: cameras.filter((c) => c.ease === 'linear').length,
          durationMs: Math.max(0, ...cues.map((c) => (c.atMs ?? 0) + (c.durationMs ?? c.spanMs ?? 0))),
          byType: cues.reduce((counts, c) => ({ ...counts, [c.type]: (counts[c.type] ?? 0) + 1 }), {}),
        });
      }
      return { takes: out };
    },
  },

  /* ── recording ────────────────────────────────────────────────────────────────────────────── */

  health: {
    group: 'recording',
    describe: 'Is the director up, is a take running, and where is the camera right now.',
    input: nothing,
    sideEffects: 'none',
    run: () => director.status(),
  },

  scrub: {
    group: 'recording',
    describe: 'Builds the world as it stands at a given millisecond of a take, without flying '
      + 'anything. This changes the world.',
    input: obj({ ...slugArg, take: str('Which take'), ms: num('The millisecond to stand at') }, ['ms']),
    sideEffects: 'world',
    needsDirector: true,
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take ?? project.takes[0]?.name);
      const { value: timeline } = await docs.readJson(take.out);
      const game = await director.health();
      if (game.running) throw new Error('a take is running — stopping it first would ruin the recording');
      const done = await director.scrub(timeline, params.ms);

      // The director reports every step it ran, which for a scrub deep into a build is three
      // thousand of them — more than any reader wants and more than a tool call can carry. What
      // the question actually is: how far did it get, and what kind of thing did it do. The tail
      // is kept because the last few steps are the ones that explain what the world looks like now.
      const events = done.events ?? [];
      const byKind = {};
      for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
      return {
        ...done,
        events: events.slice(-20),
        eventsOmitted: Math.max(0, events.length - 20),
        byKind,
      };
    },
  },

  take_run: {
    group: 'recording',
    describe: 'Records a take: the recorder, the run, the mux. Returns a job to follow rather than '
      + 'blocking for four minutes.',
    input: obj({
      ...slugArg,
      take: str('Which take'),
      capture: { type: 'string', enum: ['obs', 'x11', 'none', 'framegrab'], description: 'How to record it. framegrab needs no capture stack at all — it builds the video out of the game\'s own framebuffer, at about 19 frames a second, which is a preview rather than a master' },
      voice: str('Narration to mux under it'),
      wait: bool('Block until it finishes'),
    }),
    sideEffects: 'world',
    needsDirector: true,
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take ?? project.takes[0]?.name);
      const game = await director.health();
      if (game.running) throw new Error('a take is already running');
      const voice = params.voice ?? `${voiceDir(project.documents.beats)}/narration.mp3`;
      const hasVoice = await docs.readJsonIfPresent(voice).catch(() => null);
      const job = params.capture === 'framegrab'
        ? jobs.start('framegrab', { timeline: take.out, out: `out/${take.name}-framegrab.mp4` },
          { label: `framegrab ${take.name}` })
        : jobs.start('take', {
          timeline: take.out,
          capture: params.capture ?? 'obs',
          voice: params.voice ?? (hasVoice ? voice : undefined),
        }, { label: `take ${take.name}` });
      if (!params.wait) return { job: job.id, take: take.name, timeline: take.out, running: true };
      const result = await jobs.waitFor(job);
      return { job: job.id, exitCode: result.exitCode, lines: result.lines };
    },
  },

  take_abort: {
    group: 'recording',
    describe: 'Stops the take that is running.',
    input: nothing,
    sideEffects: 'world',
    needsDirector: true,
    run: () => director.abort(),
  },

  take_log: {
    group: 'recording',
    describe: 'What a take actually did: every cue, planned against actual, and what drifted.',
    input: obj({ ...slugArg, take: str('Which take'), threshold: num('Call a cue drifted above this many ms') }),
    sideEffects: 'none',
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take ?? project.takes[0]?.name);
      const name = path.basename(take.out, '.json');
      const log = await docs.readJsonIfPresent(`out/${name}.log.json`);
      if (!log) return { take: take.name, present: false };
      const threshold = params.threshold ?? 250;
      const events = log.value.events ?? [];
      return {
        take: take.name,
        path: log.path,
        plannedDurationMs: log.value.plannedDurationMs,
        actualDurationMs: log.value.actualDurationMs,
        recording: log.value.recording,
        recordLeadMs: log.value.recordLeadMs,
        events,
        drifted: events.filter((e) => Math.abs((e.actualMs ?? 0) - (e.plannedMs ?? 0)) > threshold),
      };
    },
  },

  verify: {
    group: 'recording',
    describe: 'Compares the built world against the schematic: block states, entities, litter, and '
      + 'whether the camera flew through anything.',
    input: obj({ ...slugArg, take: str('Which take') }),
    sideEffects: 'none',
    needsDirector: true,
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take ?? project.takes[0]?.name);
      const { value: timeline } = await docs.readJson(take.out);
      const report = await director.verify(timeline);
      return { take: take.name, ...report };
    },
  },

  preview_stills: {
    group: 'recording',
    describe: 'Runs a take and grabs stills at chosen milliseconds — a contact sheet, without a recorder.',
    input: obj({ ...slugArg, take: str('Which take'), at: arr(num(), 'Milliseconds to grab') }),
    sideEffects: 'world',
    needsDirector: true,
    async run(params) {
      const project = await projectFor(params);
      const take = projects.takeNamed(project, params.take ?? project.takes[0]?.name);
      const result = await jobs.run('preview', { timeline: take.out, at: params.at ?? [1000, 8000, 15000] });
      const stills = result.lines
        .map((line) => /^\s*(\d+)\s*ms\s*->?\s*(.+)$/.exec(line) ?? /(\d+)\s+ms\s+→\s+(.+)/.exec(line))
        .filter(Boolean)
        .map((m) => ({ ms: Number(m[1]), path: m[2].trim() }));
      return { stills, lines: result.lines };
    },
  },

  screenshot: {
    group: 'recording',
    describe: 'The game\'s own framebuffer, as a PNG.',
    input: nothing,
    sideEffects: 'none',
    needsDirector: true,
    returns: 'image',
    async run() {
      const { path: file, bytes } = await director.screenshotBytes();
      return { path: file, bytes: bytes.length, image: bytes.toString('base64'), mediaType: 'image/png' };
    },
  },

  obs_setup: {
    group: 'recording',
    describe: 'Builds the OBS scene, source and output configuration from scratch.',
    input: nothing,
    sideEffects: 'none',
    async run() {
      const result = await jobs.run('obs-setup', {});
      return { lines: result.lines };
    },
  },

  gradle: {
    group: 'recording',
    describe: 'A Gradle task of the recording instance — runClient, installSchematics.',
    input: obj({ task: str('The task'), world: str('Which world to open'), wait: bool('Block until it finishes') }, ['task']),
    sideEffects: 'files',
    async run({ task, world, wait }) {
      const job = jobs.start('gradle', { task, world }, { label: `gradle ${task}` });
      // runClient does not end — it *is* the recording instance — so it is never waited for.
      if (task === 'runClient' || wait === false) return { job: job.id, running: true, task };
      const result = await jobs.waitFor(job);
      return { job: job.id, exitCode: result.exitCode, lines: result.lines.slice(-15) };
    },
  },

  /* ── the studio itself ────────────────────────────────────────────────────────────────────── */

  job_list: {
    group: 'infrastructure',
    describe: 'Everything the studio has run this session.',
    input: nothing,
    sideEffects: 'none',
    run: () => ({ jobs: jobs.list() }),
  },

  job_log: {
    group: 'infrastructure',
    describe: 'A job\'s output, from a line onwards, and whether it has finished.',
    input: obj({ id: str('The job'), since: num('First line to return') }, ['id']),
    sideEffects: 'none',
    run: ({ id, since }) => jobs.get(id, { since: since ?? 0 }),
  },

  job_stop: {
    group: 'infrastructure',
    describe: 'Interrupts a running job.',
    input: obj({ id: str('The job') }, ['id']),
    sideEffects: 'none',
    run: ({ id }) => jobs.stop(id),
  },

  tests_run: {
    group: 'infrastructure',
    describe: 'The repository\'s own tests.',
    input: obj({ which: { type: 'string', enum: ['all', 'python'] } }),
    sideEffects: 'none',
    async run({ which }) {
      const job = jobs.start('tests', { which: which ?? 'all' });
      const result = await jobs.waitFor(job);
      return { ok: result.exitCode === 0, lines: result.lines.slice(-40) };
    },
  },
};

/** Every operation, as a list — what the MCP tool list and the HTTP router are built from. */
export function catalogue() {
  return Object.entries(ops).map(([name, op]) => ({
    name,
    group: op.group,
    describe: op.describe,
    input: op.input,
    sideEffects: op.sideEffects ?? 'none',
    needsDirector: op.needsDirector ?? false,
    returns: op.returns ?? 'json',
  }));
}

/**
 * Runs an operation by name.
 *
 * The one thing added on the way through is the check for the game: an operation that needs the
 * director and does not have it should say so in a sentence, rather than time out somewhere deep
 * in a fetch and arrive as a stack trace.
 */
export async function invoke(name, params = {}) {
  const op = ops[name];
  if (!op) throw new Error(`no such operation: ${name}`);
  if (op.needsDirector) {
    const game = await director.status();
    if (!game.up) {
      const error = new Error(`${name} needs the recording instance — start it with the gradle `
        + 'operation, task "runClient" (this is the only thing that is missing; everything else works with the game closed)');
      error.code = 'DIRECTOR_DOWN';
      throw error;
    }
  }
  return op.run(params ?? {});
}
