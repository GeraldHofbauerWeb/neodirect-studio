/**
 * The client for the mod's control server.
 *
 * Everything the studio knows about the running game goes through here: the same five endpoints
 * the CLI tools already use, plus the ones the studio adds. Kept in one place so that "is the
 * director up" has a single answer and a single way of being wrong.
 */

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';

/** How long each kind of call may take. A take is minutes; a screenshot is a tick. */
const TIMEOUTS = {
  health: 1500,
  screenshot: 20_000,
  block: 15_000,
  verify: 120_000,
  scrub: 120_000,
  path: 30_000,
  run: 45 * 60_000,
  default: 30_000,
};

export class DirectorDown extends Error {
  constructor(cause) {
    super('the director is not answering on ' + CONTROL +
      ' — start the recording instance with ./gradlew runClient');
    this.name = 'DirectorDown';
    this.code = 'DIRECTOR_DOWN';
    this.cause = cause;
  }
}

async function call(path, { method = 'GET', body = null, kind = 'default', raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS[kind] ?? TIMEOUTS.default);
  let response;
  try {
    response = await fetch(CONTROL + path, {
      method,
      body: body === null ? undefined : JSON.stringify(body),
      headers: body === null ? undefined : { 'content-type': 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`the director did not answer ${path} in time`);
    throw new DirectorDown(error);
  } finally {
    clearTimeout(timer);
  }
  if (raw) {
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered ${response.status} with something that is not JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok || parsed.error) throw new Error(parsed.error ?? `${path} answered ${response.status}`);
  return parsed;
}

/** Up? Filming? Where is the camera? Answers in under two seconds or says it is down. */
export async function health() {
  return call('/health', { kind: 'health' });
}

/** The same question, but as a fact rather than an exception. */
export async function status() {
  try {
    const body = await health();
    return { up: true, ...body };
  } catch (error) {
    return { up: false, reason: error.message };
  }
}

/** Runs a whole timeline and waits for it. Minutes, deliberately: a take is a take. */
export async function run(timeline) {
  return call('/run', { method: 'POST', body: timeline, kind: 'run' });
}

/** Compares the built world against the schematic the timeline names. */
export async function verify(timeline) {
  return call('/verify', { method: 'POST', body: timeline, kind: 'verify' });
}

/** The game's own framebuffer. Returns the path the mod wrote. */
export async function screenshot() {
  return call('/screenshot', { kind: 'screenshot' });
}

/** Block states and block-entity NBT at the given positions. */
export async function blocks(positions) {
  const query = positions.map((p) => 'pos=' + p.join(',')).join('&');
  return call('/block?' + query, { kind: 'block' });
}

/** Where the camera is and where it is looking, for turning a stance into a keyframe. */
export async function pose() {
  return call('/pose', { kind: 'health' });
}

/** The block the player is looking at, with its index in the schematic if it has one. */
export async function look({ maxDistance = 48 } = {}) {
  return call(`/look?maxDistance=${maxDistance}`, { kind: 'block' });
}

/** Puts the camera somewhere, now, or flies it there over `durationMs`. */
export async function camera(body) {
  return call('/camera', { method: 'POST', body, kind: 'default' });
}

/** Builds the world up to a given millisecond of a timeline, without flying anything. */
export async function scrub(timeline, ms) {
  return call('/scrub', { method: 'POST', body: { ...timeline, scrubToMs: ms }, kind: 'scrub' });
}

/** Samples a camera move along the curve the game will actually fly, with clearance per sample. */
export async function path(body) {
  return call('/path', { method: 'POST', body, kind: 'path' });
}

/** Stops a running take. */
export async function abort() {
  return call('/abort', { method: 'POST', body: {}, kind: 'default' });
}

/**
 * The colour the map would paint each block, for the viewport — and, incidentally, the list of
 * blocks this instance actually knows, which is how a missing mod is caught before a take.
 */
export async function blockColors() {
  return call('/blockcolors', { kind: 'block' });
}

/** The screenshot as bytes, for handing to a browser or to an MCP image block. */
export async function screenshotBytes() {
  const { path: file } = await screenshot();
  const { readFile } = await import('node:fs/promises');
  return { path: file, bytes: await readFile(file) };
}

export const controlUrl = CONTROL;
