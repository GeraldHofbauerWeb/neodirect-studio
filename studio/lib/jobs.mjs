/**
 * Running the repository's own tools, and keeping the output.
 *
 * Nothing here builds a shell string. A job names one of the commands below and passes arguments
 * as a list, which is the difference between "the studio can run the pipeline" and "the studio can
 * run anything a browser asks it to". The whitelist is also the documentation: it is the complete
 * set of things the studio does to the tree.
 *
 * Jobs are asynchronous by nature — `take.mjs` on the ore plant is nearly five minutes — so
 * starting one returns a handle, and the log arrives in pieces. Anything that wants to block can
 * await {@link waitFor}.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ROOT } from './paths.mjs';

/**
 * The commands the studio may start.
 *
 * `args` turns the operation's parameters into a command line. Anything not named here cannot be
 * run, and adding a tool to the repository means adding it here — which is what keeps the MCP
 * surface honest about covering the whole pipeline.
 */
export const COMMANDS = {
  'voice-render': {
    describe: 'Speak the beats and measure them (ElevenLabs)',
    build: ({ beats, beat }) => ['node', ['tools/render-voice.mjs', 'render', beats, ...(beat ? [beat] : [])]],
  },
  'voice-audition': {
    describe: 'Speak one beat in every audition voice',
    build: ({ beats, beat }) => ['node', ['tools/render-voice.mjs', 'audition', beats, beat]],
  },
  'make-timeline': {
    describe: 'Resolve a storyboard against the measured narration',
    build: ({ storyboard, out }) => ['node', ['tools/make-timeline.mjs', storyboard, out]],
  },
  'mk-build-take': {
    describe: 'Generate the silent build take',
    build: ({ shots, style, lockedExcept, msPerBlock }) => ['node', ['tools/mk-build-take.mjs',
      ...(shots ? [shots] : []),
      ...(style ? ['--style', style] : []),
      ...(lockedExcept !== undefined ? ['--locked-except', lockedExcept] : []),
      ...(msPerBlock ? ['--ms-per-block', String(msPerBlock)] : [])]],
    capture: 'stdout',
  },
  'mk-flow-take': {
    describe: 'Generate the live-flow take',
    build: ({ stations }) => ['node', ['tools/mk-flow-take.mjs', ...(stations ? [stations] : [])]],
    capture: 'stdout',
  },
  'join-takes': {
    describe: 'Lay several takes end to end',
    build: ({ takes, gap, name }) => ['node', ['tools/join-takes.mjs', ...takes,
      ...(gap !== undefined ? ['--gap', String(gap)] : []),
      ...(name ? ['--take', name] : [])]],
    capture: 'stdout',
  },
  take: {
    describe: 'Record a take: OBS, the run, the mux',
    build: ({ timeline, capture = 'obs', out, voice }) => ['node', ['tools/take.mjs', timeline,
      ...(capture === 'none' ? ['--no-capture'] : ['--capture', capture]),
      ...(out ? ['--out', out] : []),
      ...(voice ? ['--voice', voice] : [])]],
  },
  framegrab: {
    describe: 'Build a take out of the game\'s own framebuffer, with no capture stack at all',
    build: ({ timeline, out }) => ['node', ['tools/framegrab.mjs', timeline, ...(out ? [out] : [])]],
  },
  verify: {
    describe: 'Compare the built world against the schematic',
    build: ({ timeline }) => ['node', ['tools/verify.mjs', timeline]],
  },
  preview: {
    describe: 'Run a take and grab stills at chosen milliseconds',
    build: ({ timeline, at = [] }) => ['node', ['tools/preview.mjs', timeline, ...at.map(String)]],
  },
  'camera-drift': {
    describe: 'Fly a path and measure how far the camera strayed from it',
    build: ({ timeline }) => ['node', ['tools/camera-drift.mjs', timeline]],
  },
  'obs-setup': {
    describe: 'Build the OBS scene, source and output config',
    build: () => ['node', ['tools/obs-setup.mjs']],
  },
  parts: {
    describe: 'Resolve a parts manifest into positions',
    build: ({ schematic, manifest, json, map }) => ['python3', ['tools/parts.py', schematic, manifest,
      ...(json ? ['--json', json] : []),
      ...(map ? ['--map'] : [])]],
  },
  'check-storyboard': {
    describe: 'Check a storyboard against its schematic',
    build: ({ storyboard }) => ['python3', ['tools/check-storyboard.py', storyboard]],
  },
  'world-clip': {
    describe: 'Cut a build out of a saved world',
    build: ({ spec, dryRun }) => ['python3', ['tools/world_clip.py', '--spec', spec, ...(dryRun ? ['--dry-run'] : [])]],
  },
  'world-pull': {
    describe: 'Fetch the region and entity files around a coordinate off the server',
    build: ({ x, z, radius = 1, dest }) => ['bash', ['tools/pull-world-region.sh', String(x), String(z), String(radius), ...(dest ? [dest] : [])]],
  },
  'schematic-edit': {
    describe: 'Replay the recorded edits against an untouched export',
    build: ({ source, edits, out }) => ['python3', ['tools/schematic_edit.py', source, edits, out]],
  },
  'schematic-json': {
    describe: 'Dump a schematic as JSON',
    build: ({ schematic, blocks = true }) => ['python3', ['tools/schematic_json.py', schematic, ...(blocks ? [] : ['--summary'])]],
    capture: 'stdout',
  },
  gradle: {
    describe: 'A Gradle task of the recording instance',
    build: ({ task, world }) => ['./gradlew', [task, ...(world ? ['-Pneodirect.world=' + world] : [])]],
  },
  tests: {
    describe: 'The repository\'s own tests',
    build: ({ which = 'all' }) => (which === 'python'
      ? ['python3', ['tools/test_nbt_tools.py']]
      : ['node', ['--test', 'studio/test/**/*.test.mjs']]),
  },
};

/** Everything that has run, or is running, this session. */
const jobs = new Map();

/** Emits `line`, `end` and `start`, so the HTTP server can turn them into server-sent events. */
export const events = new EventEmitter();

/** Cap on what a single job keeps, so a chatty tool cannot eat the process. */
const MAX_LINES = 5000;

/**
 * Starts a job and returns its handle straight away.
 *
 * `capture: 'stdout'` marks the generators, whose output *is* the artefact — they write JSON to
 * stdout and diagnostics to stderr, so their stdout is kept whole and their stderr becomes the
 * log. For everything else both streams are log.
 */
export function start(command, params = {}, { label = null } = {}) {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`no such command: ${command} (known: ${Object.keys(COMMANDS).join(', ')})`);
  const [bin, args] = spec.build(params ?? {});
  const id = randomUUID().slice(0, 8);
  const job = {
    id,
    command,
    label: label ?? command,
    argv: [bin, ...args],
    params,
    started: Date.now(),
    finished: null,
    exitCode: null,
    lines: [],
    stdout: '',
    truncated: false,
    running: true,
  };
  jobs.set(id, job);

  const child = spawn(bin, args, { cwd: ROOT, env: process.env });
  job.pid = child.pid;
  events.emit('start', { id, command: job.command, label: job.label, argv: job.argv });

  const collect = (stream, isStdout) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (isStdout && spec.capture === 'stdout') {
        job.stdout += chunk;
        return;
      }
      rest += chunk;
      const parts = rest.split('\n');
      rest = parts.pop();
      for (const line of parts) push(job, line);
    });
    stream.on('end', () => {
      if (rest) push(job, rest);
    });
  };
  collect(child.stdout, true);
  collect(child.stderr, false);

  job.done = new Promise((resolveDone) => {
    child.on('error', (error) => {
      push(job, `failed to start: ${error.message}`);
      job.exitCode = -1;
      finish(job);
      resolveDone(job);
    });
    child.on('close', (code) => {
      job.exitCode = code;
      finish(job);
      resolveDone(job);
    });
  });
  job.kill = () => child.kill('SIGINT');
  return job;
}

function push(job, line) {
  if (job.lines.length >= MAX_LINES) {
    job.truncated = true;
    job.lines.shift();
  }
  job.lines.push(line);
  events.emit('line', { id: job.id, line });
}

function finish(job) {
  job.running = false;
  job.finished = Date.now();
  events.emit('end', { id: job.id, exitCode: job.exitCode, ms: job.finished - job.started });
}

/** A job's state, with its log from `since` onwards. */
export function get(id, { since = 0 } = {}) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  return {
    id: job.id,
    command: job.command,
    label: job.label,
    argv: job.argv,
    running: job.running,
    exitCode: job.exitCode,
    started: job.started,
    finished: job.finished,
    ms: (job.finished ?? Date.now()) - job.started,
    truncated: job.truncated,
    lines: job.lines.slice(since),
    nextLine: job.lines.length,
  };
}

/** Everything this session has run, newest first. */
export function list() {
  return [...jobs.values()]
    .sort((a, b) => b.started - a.started)
    .map((job) => ({
      id: job.id, command: job.command, label: job.label, running: job.running,
      exitCode: job.exitCode, started: job.started, ms: (job.finished ?? Date.now()) - job.started,
    }));
}

/** Waits for a job to end and hands back its result, stdout included. */
export async function waitFor(job) {
  await job.done;
  return {
    ...get(job.id),
    stdout: job.stdout,
  };
}

/** Starts a job and waits for it — for the short ones, where a handle would only be ceremony. */
export async function run(command, params = {}, options = {}) {
  const job = start(command, params, options);
  const result = await waitFor(job);
  if (result.exitCode !== 0) {
    const tail = result.lines.slice(-12).join('\n');
    const error = new Error(`${command} failed (exit ${result.exitCode})\n${tail}`);
    error.job = result;
    throw error;
  }
  return result;
}

export function stop(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (job.running) job.kill();
  return { id, stopped: job.running };
}
