#!/usr/bin/env node
/**
 * The studio's HTTP side: the same operations, for a browser.
 *
 * Every route but four is generated from the operations table, so the browser and the MCP server
 * cannot drift apart. The four that are not are the ones that are not JSON: the event stream, a
 * screenshot, media out of `out/`, and the built front end itself.
 *
 * Bound to 127.0.0.1, like the director it talks to. No authentication, for the same reason: this
 * is a tool that drives a game and a recorder on one desk.
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogue, invoke } from './lib/ops.mjs';
import * as jobs from './lib/jobs.mjs';
import * as director from './lib/director.mjs';
import { resolve, ROOT } from './lib/paths.mjs';

const PORT = Number(process.env.NEODIRECT_STUDIO_PORT ?? 8778);
const WEB = fileURLToPath(new URL('web/dist/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.srt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The event stream: job output, job endings, and whether the game is still there.
 *
 * Server-sent events rather than a socket, because everything here flows one way and SSE is
 * already in both Node and the browser without a dependency on either side.
 */
function events(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { at: Date.now(), jobs: jobs.list() });

  const onStart = (data) => send('job-start', data);
  const onLine = (data) => send('job-line', data);
  const onEnd = (data) => send('job-end', data);
  jobs.events.on('start', onStart);
  jobs.events.on('line', onLine);
  jobs.events.on('end', onEnd);

  let last = null;
  const poll = setInterval(async () => {
    const state = await director.status();
    const now = JSON.stringify([state.up, state.running ?? false, state.eye ?? null]);
    if (now !== last) {
      last = now;
      send('director', state);
    }
  }, 2000);

  request.on('close', () => {
    clearInterval(poll);
    jobs.events.off('start', onStart);
    jobs.events.off('line', onLine);
    jobs.events.off('end', onEnd);
  });
}

/** Files out of the repository's `out/`, with ranges, so a take can be scrubbed in the player. */
async function media(url, request, response) {
  const relPath = url.searchParams.get('path');
  if (!relPath || !relPath.startsWith('out/')) return json(response, 400, { error: 'only out/ is served' });
  const full = resolve(relPath);
  const info = await stat(full).catch(() => null);
  if (!info) return json(response, 404, { error: `${relPath} is not there` });
  const type = TYPES[path.extname(full)] ?? 'application/octet-stream';
  const range = request.headers.range;
  if (range) {
    const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range) ?? [];
    const start = from ? Number(from) : 0;
    const end = to ? Number(to) : info.size - 1;
    response.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    createReadStream(full, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { 'content-type': type, 'content-length': info.size, 'accept-ranges': 'bytes' });
  createReadStream(full).pipe(response);
}

/** The built front end, with anything unknown falling back to index.html for client routing. */
async function statics(url, response) {
  const wanted = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  for (const candidate of [wanted, 'index.html']) {
    const full = path.join(WEB, candidate);
    if (!full.startsWith(WEB)) break;
    const info = await stat(full).catch(() => null);
    if (info?.isFile()) {
      response.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream' });
      createReadStream(full).pipe(response);
      return;
    }
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('The studio front end is not built yet — run `npm run build` in studio/, '
    + 'or `npm run dev` for the development server.\n');
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/api/ops') return json(response, 200, { ops: catalogue() });
    if (url.pathname === '/api/events') return events(request, response);
    if (url.pathname === '/api/media') return media(url, request, response);
    if (url.pathname === '/api/screenshot') {
      const { bytes } = await director.screenshotBytes();
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length, 'cache-control': 'no-store' });
      return response.end(bytes);
    }
    if (url.pathname.startsWith('/api/op/')) {
      if (request.method !== 'POST') return json(response, 405, { error: 'operations are POSTed' });
      const name = url.pathname.slice('/api/op/'.length);
      const params = await readBody(request);
      const result = await invoke(name, params);
      return json(response, 200, result ?? {});
    }
    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: `no route ${url.pathname}` });
    return statics(url, response);
  } catch (error) {
    return json(response, error.code === 'DIRECTOR_DOWN' ? 503 : 400, { error: error.message, code: error.code });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`studio on http://127.0.0.1:${PORT} — ${catalogue().length} operations, `
    + `director at ${director.controlUrl}\n`);
});
