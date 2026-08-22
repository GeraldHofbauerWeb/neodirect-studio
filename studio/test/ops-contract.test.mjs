import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { catalogue, ops } from '../lib/ops.mjs';
import { COMMANDS } from '../lib/jobs.mjs';

const PREFIX = 'neodirect_';

/** Speaks MCP over stdio the way a client does, and returns the replies it got. */
async function askTheMcpServer(messages, ms = 3000) {
  const child = spawn('node', ['studio/mcp.mjs'], {
    cwd: new URL('../../', import.meta.url).pathname,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const replies = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) replies.push(JSON.parse(line));
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await new Promise((r) => setTimeout(r, 300));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const message of messages) send(message);
  await new Promise((r) => setTimeout(r, ms));
  child.kill();
  return replies;
}

test('every operation says what it is, what it takes, and what it touches', () => {
  for (const op of catalogue()) {
    assert.match(op.name, /^[a-z][a-z0-9_]*$/, `${op.name} is not a usable tool name`);
    assert.ok(op.describe && op.describe.length > 20, `${op.name} has no real description`);
    assert.ok(op.group, `${op.name} belongs to no group`);
    assert.equal(op.input.type, 'object', `${op.name}'s input schema is not an object`);
    assert.ok(['none', 'files', 'world'].includes(op.sideEffects), `${op.name} has odd side effects`);
    assert.equal(typeof ops[op.name].run, 'function');
  }
});

test('an operation that changes the world says so and needs the game', () => {
  for (const op of catalogue()) {
    if (op.sideEffects === 'world') {
      assert.ok(op.needsDirector, `${op.name} changes the world but does not require the director`);
    }
  }
});

test('the MCP server offers exactly the operations, and nothing else', async () => {
  const replies = await askTheMcpServer([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], 1200);
  const tools = replies.find((r) => r.id === 2)?.result?.tools ?? [];
  const offered = tools.map((t) => t.name).sort();
  const expected = catalogue().map((op) => PREFIX + op.name).sort();
  assert.deepEqual(offered, expected, 'the MCP tool list and the operations table have drifted apart');
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, `${tool.name} arrives with no description`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('the HTTP side answers on the same names, and refuses what it should', async () => {
  const port = 8790 + Math.floor(process.pid % 50);
  const server = spawn('node', ['studio/server.mjs'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, NEODIRECT_STUDIO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await new Promise((ready) => server.stdout.once('data', ready));
    const ask = async (path, init) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      return { status: response.status, body: await response.json() };
    };
    const listed = await ask('/api/ops');
    assert.deepEqual(listed.body.ops.map((o) => o.name).sort(), catalogue().map((o) => o.name).sort(),
      'the HTTP catalogue and the operations table have drifted apart');

    const posted = await ask('/api/op/project_list', { method: 'POST', body: '{}' });
    assert.equal(posted.status, 200);
    assert.ok(Array.isArray(posted.body.projects));

    const getting = await ask('/api/op/project_list');
    assert.equal(getting.status, 405, 'operations should only be reachable by POST');

    const nonsense = await ask('/api/op/does_not_exist', { method: 'POST', body: '{}' });
    assert.equal(nonsense.status, 400);
    assert.match(nonsense.body.error, /no such operation/);
  } finally {
    server.kill();
  }
});
