/**
 * What is out of date, and what would bring it back.
 *
 * The pipeline is a chain of derived files, and today the only record of whether a link still
 * holds is the modification time of the files either side of it. That is enough to miss things:
 * `schematics/ore_plant.report.json` currently claims 1100 blocks for a schematic that has 926,
 * and the narration quotes the report.
 *
 * So the checks here prefer content over timestamps wherever content can answer:
 *
 *   - the report is compared against the block count the schematic really has
 *   - a beat counts as spoken when its text equals the characters in its alignment file, which is
 *     the text ElevenLabs actually said. Modification times cannot answer this at all —
 *     `render-voice.mjs` rewrites the beats file *after* writing the audio, so the beats file is
 *     always the newer of the two, whether or not anything was re-spoken
 *   - the parts file is stale when a position in it is no longer a block in the schematic
 *
 * Every stale link carries the command that fixes it, because a status that only says "stale" puts
 * the person back in the shell history it was meant to replace.
 */

import { stat } from 'node:fs/promises';
import { resolve } from './paths.mjs';
import { readJson, readJsonIfPresent } from './docs.mjs';
import * as schematic from './schematic.mjs';
import { voiceDir } from '../../tools/render-voice.mjs';

async function mtime(relPath) {
  try {
    return (await stat(resolve(relPath))).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const link = (from, to, state, why, fix) => ({ from, to, state, why, fix });

/**
 * `to` should be newer than `from`, or it was built from something older than what it is built on.
 *
 * Called `suspect` rather than `stale` on purpose. A modification time answers "was this written
 * after that" and not "does this still follow from that", and the two come apart for honest
 * reasons: restoring a snapshot rewrites files with the content they already had, and so does
 * regenerating something that has not changed. Since the generated files here are deterministic
 * functions of their inputs, the way to be sure is to run the generator and compare — which is
 * what the fix does, and why it is safe to offer as a button rather than a warning.
 */
async function byTime(from, to, fix, what) {
  const [a, b] = await Promise.all([mtime(from), mtime(to)]);
  if (a === null) return link(from, to, 'missing', `${from} is not there`, fix);
  if (b === null) return link(from, to, 'missing', `${to} has never been built`, fix);
  if (b < a) {
    return link(from, to, 'suspect',
      `${to} was written before ${from} — regenerate it to be sure; it may come out identical`, fix);
  }
  return link(from, to, 'fresh', what ?? `${to} follows ${from}`, fix);
}

/**
 * The state of one project's pipeline: acquisition, narration, choreography, takes.
 */
export async function status(project) {
  const links = [];
  const notes = [];
  const { documents = {}, derived = {}, takes = [] } = project;

  // ── the schematic and what is cut out of it ─────────────────────────────────────────────────
  if (documents.clip && derived.schematic) {
    links.push(await byTime(documents.clip, derived.schematic,
      { command: 'world-clip', params: { spec: documents.clip } },
      'the schematic was cut with the current spec'));
  }
  if (derived.schematic && derived.groups && documents.partsManifest) {
    const fix = {
      command: 'parts',
      params: { schematic: derived.schematic, manifest: documents.partsManifest, json: derived.groups },
    };
    links.push(await byTime(documents.partsManifest, derived.groups, fix, 'the parts follow the manifest'));
    links.push(await byTime(derived.schematic, derived.groups, fix, 'the parts follow the schematic'));
    try {
      const resolved = await schematic.groups(derived.groups, derived.schematic);
      if (resolved.stale.length) {
        links.push(link(derived.schematic, derived.groups, 'stale',
          `${resolved.stale.length} positions in the parts file are no longer blocks in the schematic`, fix));
      }
      const blocks = (await schematic.summary(derived.schematic)).blocks;
      if (resolved.blocks !== blocks) {
        links.push(link(derived.schematic, derived.groups, 'stale',
          `the parts file counts ${resolved.blocks} blocks, the schematic has ${blocks}`, fix));
      }
    } catch (error) {
      notes.push({ level: 'error', text: `parts could not be resolved: ${error.message}` });
    }
  }

  // ── the report, which the narration quotes ──────────────────────────────────────────────────
  if (derived.schematic) {
    const reportPath = derived.schematic.replace(/\.nbt$/, '.report.json');
    const report = await readJsonIfPresent(reportPath);
    if (report) {
      const blocks = (await schematic.summary(derived.schematic)).blocks;
      if (report.value.blocks !== blocks) {
        notes.push({
          level: 'error',
          text: `${reportPath} says ${report.value.blocks} blocks, the schematic has ${blocks} — `
            + 'anything the narration took from the report is quoting a build that no longer exists',
          fix: { command: 'world-clip', params: { spec: documents.clip } },
        });
      }
    }
  }

  // ── narration ───────────────────────────────────────────────────────────────────────────────
  const beatState = documents.beats ? await beats(documents.beats) : null;
  if (beatState) {
    // Deliberately not added to `links`: the beats have their own section, and a beat that needs
    // speaking is not a derivation that needs rebuilding — it is a decision about the voice.
  }

  // ── choreography ────────────────────────────────────────────────────────────────────────────
  for (const take of takes) {
    if (!take.out) continue;
    if (take.generator === 'make-timeline') {
      if (!documents.storyboard) continue;
      const fix = { command: 'make-timeline', params: { storyboard: documents.storyboard, out: take.out, take: take.name } };
      links.push(await byTime(documents.storyboard, take.out, fix, 'the timeline follows the storyboard'));
      if (documents.beats) {
        links.push(await byTime(documents.beats, take.out, fix, 'the timeline follows the narration'));
      }
    } else if (take.generator === 'mk-build-take' && documents.shots) {
      links.push(await byTime(documents.shots, take.out,
        { command: 'mk-build-take', params: { shots: documents.shots, take: take.name, ...(take.args ?? {}) } },
        'the take follows the shot list'));
    } else if (derived.groups) {
      links.push(await byTime(derived.groups, take.out,
        { command: take.generator, params: { take: take.name, ...(take.args ?? {}) } },
        'the take follows the parts'));
    }
  }

  const worst = links.some((l) => l.state === 'missing') ? 'missing'
    : links.some((l) => l.state === 'stale') ? 'stale'
      : links.some((l) => l.state === 'suspect') ? 'suspect' : 'fresh';
  return { slug: project.slug, state: worst, links, notes, narration: beatState };
}

/**
 * Which beats have been rewritten since they were last spoken.
 *
 * A beat is fresh when three things agree: it has a measured duration, an alignment exists, and
 * the characters in that alignment spell the text the beats file now carries. Anything else names
 * which of the three is missing.
 */
export async function beats(beatsPath) {
  const { value } = await readJson(beatsPath);
  const dir = voiceDir(beatsPath);
  const out = [];
  for (const beat of value.beats ?? []) {
    const alignment = await readJsonIfPresent(`${dir}/${beat.id}.alignment.json`);
    if (!alignment) {
      out.push({ id: beat.id, text: beat.text, state: 'missing', why: 'never spoken',
        measuredMs: beat.measuredMs ?? null, plannedMs: beat.plannedMs ?? null });
      continue;
    }
    const spoken = (alignment.value.characters ?? []).join('');
    if (spoken !== beat.text) {
      out.push({
        id: beat.id,
        text: beat.text,
        state: 'stale',
        why: 'the text has been rewritten since it was spoken',
        measuredMs: beat.measuredMs ?? null,
        spokenChars: spoken.length,
        textChars: beat.text.length,
      });
      continue;
    }
    if (typeof beat.measuredMs !== 'number' || typeof beat.startMs !== 'number') {
      out.push({ id: beat.id, text: beat.text, state: 'stale',
        why: 'spoken, but the beats file has no measurement', measuredMs: null });
      continue;
    }
    out.push({ id: beat.id, text: beat.text, state: 'fresh', why: 'spoken and measured',
      measuredMs: beat.measuredMs, startMs: beat.startMs });
  }
  const measured = out.every((b) => b.state === 'fresh');
  return {
    path: beatsPath,
    voice: dir,
    totalMs: value.totalMs ?? null,
    voiceId: value.voiceId ?? null,
    voiceName: value.voiceName ?? null,
    measured,
    beats: out,
  };
}
