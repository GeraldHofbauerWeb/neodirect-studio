/**
 * Minimal obs-websocket v5 client.
 *
 * No dependency: Node 22+ ships a native WebSocket, so this whole toolchain stays
 * `node tools/...` with an empty node_modules.
 *
 * Protocol, for reference: server sends Hello (op 0), we answer Identify (op 1) with an auth
 * string when the server asks for one, server confirms with Identified (op 2). After that,
 * requests are op 6 and responses op 7, matched by requestId.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Credentials live in ~/.config/neodirect/obs.env, the same shape as the other credential files on
 * this machine. Environment variables win, so a one-off run can override without editing anything.
 */
function credentials() {
  const file = join(homedir(), '.config', 'neodirect', 'obs.env');
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match) values[match[1]] = match[2].trim();
    }
  } catch {
    // No credential file is fine — OBS may have no password set.
  }
  return values;
}

const stored = credentials();
const DEFAULT_URL = process.env.OBS_WEBSOCKET_URL ?? stored.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455';
const DEFAULT_PASSWORD = process.env.OBS_WEBSOCKET_PASSWORD ?? stored.OBS_WEBSOCKET_PASSWORD ?? '';

const sha256b64 = (value) => createHash('sha256').update(value).digest('base64');

/** obs-websocket's two-step challenge: hash the password with the salt, then that with the challenge. */
function authString(password, salt, challenge) {
  return sha256b64(sha256b64(password + salt) + challenge);
}

export class Obs {
  #socket;
  #pending = new Map();

  static async connect({ url = DEFAULT_URL, password = DEFAULT_PASSWORD, timeoutMs = 10_000 } = {}) {
    const obs = new Obs();
    await obs.#open(url, password, timeoutMs);
    return obs;
  }

  #open(url, password, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;

      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`OBS did not identify within ${timeoutMs} ms at ${url}. Is OBS running with the WebSocket server enabled?`));
      }, timeoutMs);

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`could not reach OBS at ${url}. Start OBS, then enable Tools > WebSocket Server Settings.`));
      });

      socket.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.op === 0) {
          const identify = { rpcVersion: 1 };
          if (msg.d.authentication) {
            if (!password) {
              clearTimeout(timer);
              reject(new Error('OBS requires a WebSocket password. Set OBS_WEBSOCKET_PASSWORD.'));
              return;
            }
            identify.authentication = authString(password, msg.d.authentication.salt, msg.d.authentication.challenge);
          }
          socket.send(JSON.stringify({ op: 1, d: identify }));
          return;
        }

        if (msg.op === 2) {
          clearTimeout(timer);
          resolve();
          return;
        }

        if (msg.op === 7) {
          const waiter = this.#pending.get(msg.d.requestId);
          if (!waiter) return;
          this.#pending.delete(msg.d.requestId);
          if (msg.d.requestStatus?.result) {
            waiter.resolve(msg.d.responseData ?? {});
          } else {
            waiter.reject(new Error(`OBS request ${msg.d.requestType} failed: ${msg.d.requestStatus?.comment ?? 'unknown error'}`));
          }
        }
      });
    });
  }

  request(requestType, requestData = {}) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  async startRecord() {
    const { outputActive } = await this.request('GetRecordStatus');
    if (outputActive) {
      // Refuse rather than silently append to somebody else's recording.
      throw new Error('OBS is already recording — stop that recording first.');
    }
    await this.request('StartRecord');
  }

  /** Returns the path OBS wrote. */
  async stopRecord() {
    const { outputPath } = await this.request('StopRecord');
    return outputPath;
  }

  close() {
    this.#socket?.close();
  }
}

// Small CLI so the connection can be sanity-checked on its own:
//   node tools/obs.mjs status
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] ?? 'status';
  const obs = await Obs.connect();
  try {
    if (command === 'status') {
      console.log(await obs.request('GetRecordStatus'));
      console.log(await obs.request('GetVersion'));
    } else if (command === 'start') {
      await obs.startRecord();
      console.log('recording');
    } else if (command === 'stop') {
      console.log(await obs.stopRecord());
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    obs.close();
  }
}
