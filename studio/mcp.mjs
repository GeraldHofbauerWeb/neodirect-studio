#!/usr/bin/env node
/**
 * The studio, as tools an agent can call.
 *
 * Same operations as the browser front end, same code underneath — this file is only the
 * translation into MCP's shape. Which is the point: anything the studio grows, an agent can do,
 * without anybody remembering to expose it twice.
 *
 * Three things are shaped for a reader rather than a renderer:
 *
 *   - a screenshot comes back as an image, not a path, so the framing can actually be judged
 *   - long jobs return a handle immediately; a take is four minutes and no tool call should be
 *   - the authored documents are also resources, so reading one is not a tool call at all
 *
 * Registered from `.mcp.json` in the repository root as `node studio/mcp.mjs`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { catalogue, invoke } from './lib/ops.mjs';
import * as projects from './lib/project.mjs';
import * as docs from './lib/docs.mjs';

const PREFIX = 'neodirect_';

/** How much of a result to hand over before it stops being readable and starts being a dump. */
const MAX_CHARS = 60_000;

const server = new Server(
  { name: 'neodirect', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: catalogue().map((op) => ({
    name: PREFIX + op.name,
    description: describe(op),
    inputSchema: op.input ?? { type: 'object', properties: {} },
  })),
}));

/** The description an agent reads, with the two facts it needs before calling: writes, and needs. */
function describe(op) {
  const notes = [];
  if (op.sideEffects === 'files') notes.push('writes files');
  if (op.sideEffects === 'world') notes.push('changes the world in the running game');
  if (op.needsDirector) notes.push('needs the recording instance to be running');
  return notes.length ? `${op.describe} (${notes.join('; ')})` : op.describe;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name.startsWith(PREFIX)
    ? request.params.name.slice(PREFIX.length)
    : request.params.name;
  try {
    const result = await invoke(name, request.params.arguments ?? {});
    return { content: present(name, result) };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
    };
  }
});

/**
 * Turns a result into content.
 *
 * An image comes back as an image; everything else as JSON, trimmed if it is enormous — a block
 * list of a thousand entries is a fine thing to hold in a viewport and a poor thing to read.
 */
function present(name, result) {
  if (result && result.image && result.mediaType) {
    return [
      { type: 'image', data: result.image, mimeType: result.mediaType },
      { type: 'text', text: JSON.stringify({ path: result.path, bytes: result.bytes }) },
    ];
  }
  let text = JSON.stringify(result, null, 2);
  if (text && text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + `\n… trimmed, ${text.length} characters in all. `
      + 'Ask for a narrower slice — a single part, a summary, or one cue.';
  }
  return [{ type: 'text', text: text ?? 'done' }];
}

/* The authored documents, so reading one does not have to be a tool call. */

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const { projects: found } = await projects.discover();
  const resources = [];
  for (const project of found) {
    for (const [role, file] of Object.entries(project.documents ?? {})) {
      resources.push({
        uri: `neodirect://${file}`,
        name: `${project.slug} · ${role}`,
        description: `The ${role} of ${project.name}`,
        mimeType: file.endsWith('.md') ? 'text/markdown' : 'application/json',
      });
    }
    resources.push({
      uri: `neodirect://${project.manifest}`,
      name: `${project.slug} · project`,
      description: `What ${project.name} is made of`,
      mimeType: 'application/json',
    });
  }
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const file = request.params.uri.replace(/^neodirect:\/\//, '');
  const { text } = await docs.readText(file);
  return {
    contents: [{
      uri: request.params.uri,
      mimeType: file.endsWith('.md') ? 'text/markdown' : 'application/json',
      text,
    }],
  };
});

await server.connect(new StdioServerTransport());
