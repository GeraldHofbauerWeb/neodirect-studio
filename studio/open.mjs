#!/usr/bin/env node
/**
 * Opens the studio the way it is meant to be used: in a window of its own.
 *
 *   node studio/open.mjs            start the server if it is not up, then open the window
 *   node studio/open.mjs --no-serve open the window, and fail if nothing is serving
 *   node studio/open.mjs --url      print the address and exit, for a script that wants it
 *
 * The studio is a web app, but a browser tab is the wrong shape for it. It sits beside Minecraft
 * and OBS on the same desk, gets alt-tabbed to for one number and away again, and it should be its
 * own thing in the window list rather than the ninth tab of a browser that also has the wiki open.
 * Every Chromium-family browser can do that with `--app=`: no tab strip, no address bar, its own
 * window class, its own icon.
 *
 * Firefox has no equivalent — `--kiosk` takes the whole screen and is not the same offer — so on a
 * machine with only Firefox this falls back to a normal tab and says so, rather than pretending.
 *
 * Nothing here is installed. The launcher finds a browser, starts the server if it has to, and
 * hands over; `node studio/desktop-entry.mjs` is the separate step that puts it in the application
 * menu, because writing to a user's home is not something a launcher should do behind their back.
 */

import { spawn } from 'node:child_process';
import { open as openFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.NEODIRECT_STUDIO_PORT ?? 8778);
export const url = `http://127.0.0.1:${PORT}/`;

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Where a detached server's output goes, since it no longer has a terminal to write to. */
const STATE = path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'),
  'neodirect-studio');

/**
 * The window class the studio asks for, and the one a desktop entry has to name back.
 *
 * A window manager groups by this string, so it is what decides whether the studio gets its own
 * icon in the dock or is filed under the browser it happens to be drawn by.
 */
export const WM_CLASS = 'neodirect-studio';

/**
 * Browsers that can open a page as an application window, best first.
 *
 * The default browser goes to the front when it is one of them: someone who chose Brave should get
 * the studio drawn by Brave, rather than by whichever Chromium happens to be installed as a
 * dependency of something else.
 */
const APP_CAPABLE = [
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  'brave', 'brave-browser', 'vivaldi-stable', 'vivaldi', 'microsoft-edge-stable', 'microsoft-edge',
];

/**
 * Picks the browser to open the window with.
 *
 * @param available  which commands exist on this machine, in any order
 * @param preferred  the desktop file the system calls the default browser, if it says
 * @returns {{command: string, app: boolean}} `app: false` means it can only manage a tab
 */
export function chooseBrowser(available, preferred, override) {
  const has = (name) => available.includes(name);
  if (override) return { command: override, app: APP_CAPABLE.includes(path.basename(override)) };

  // "brave-browser.desktop" is how the setting names Brave, whose command is `brave`. Matching on
  // the stem and letting the loop below find the real command keeps that from needing a table.
  const stem = preferred ? path.basename(preferred, '.desktop') : null;
  const order = stem
    ? [...APP_CAPABLE.filter((name) => name.startsWith(stem) || stem.startsWith(name)), ...APP_CAPABLE]
    : APP_CAPABLE;
  for (const name of order) if (has(name)) return { command: name, app: true };
  for (const name of ['firefox', 'xdg-open']) if (has(name)) return { command: name, app: false };
  return null;
}

/**
 * The arguments that turn a page into a window. Kept separate so the test can read them.
 *
 * The profile is the studio's own rather than the browsing one, and that is the load-bearing
 * flag. A Chromium already running on a profile does not start a second process: it forwards the
 * request to the one that is up, which then draws the window with *its* class — so `--class` would
 * be quietly ignored and the studio would land in the window list as another browser window. Its
 * own profile also means no extension reaching into a page that drives a game.
 */
export function appArguments(address) {
  return [
    `--app=${address}`,
    // Its own class, so the window manager files it as the studio and not as the browser.
    `--class=${WM_CLASS}`,
    `--user-data-dir=${path.join(STATE, 'browser')}`,
    '--window-size=1600,1000',
    // A fresh profile would otherwise open with the welcome tour, and offer to become the default
    // browser in a window that has no tab strip to dismiss the bar from.
    '--no-default-browser-check',
    '--no-first-run',
  ];
}

async function serving() {
  try {
    const response = await fetch(`${url}api/ops`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the studio server as a background process that outlives this one.
 *
 * Detached on purpose: the launcher's job is to get a window open and get out of the way, and a
 * server that died with it would take the studio down the moment the terminal was closed.
 */
async function startServer() {
  await mkdir(STATE, { recursive: true });
  const log = await openFile(path.join(STATE, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  for (let waited = 0; waited < 15000; waited += 250) {
    if (await serving()) {
      await log.close();
      return true;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  await log.close();
  return false;
}

/**
 * Builds the front end if it has never been built.
 *
 * Only when it is missing altogether, not when it is merely older than the source: deciding that
 * for someone in the middle of `npm run dev` would rebuild under them. A first run on a fresh
 * clone, though, should end in a studio rather than in an explanation of how to get one.
 */
async function buildIfMissing() {
  const built = await stat(path.join(HERE, 'web', 'dist', 'index.html')).catch(() => null);
  if (built) return true;
  process.stdout.write('the front end has not been built yet — building it once\n');
  return new Promise((done) => {
    const build = spawn('npm', ['run', 'build'], { cwd: HERE, stdio: 'inherit' });
    build.on('exit', (code) => done(code === 0));
    build.on('error', () => done(false));
  });
}

async function which(name) {
  return new Promise((done) => {
    const probe = spawn('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    probe.on('exit', (code) => done(code === 0));
    probe.on('error', () => done(false));
  });
}

async function defaultBrowser() {
  return new Promise((done) => {
    const probe = spawn('xdg-settings', ['get', 'default-web-browser']);
    let out = '';
    probe.stdout?.on('data', (chunk) => { out += chunk; });
    probe.on('exit', (code) => done(code === 0 ? out.trim() : null));
    probe.on('error', () => done(null));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--url')) {
    process.stdout.write(`${url}\n`);
    return 0;
  }

  if (!(await serving())) {
    if (argv.includes('--no-serve')) {
      process.stderr.write(`nothing is serving on ${url} — run \`npm run serve\` in studio/\n`);
      return 1;
    }
    if (!(await buildIfMissing())) {
      process.stderr.write('the front end would not build — run `npm install` in studio/ first\n');
      return 1;
    }
    process.stdout.write(`starting the studio server on ${url}\n`);
    if (!(await startServer())) {
      process.stderr.write(`the server did not come up — see ${path.join(STATE, 'server.log')}\n`);
      return 1;
    }
  }

  const available = [];
  for (const name of [...APP_CAPABLE, 'firefox', 'xdg-open']) {
    if (await which(name)) available.push(name);
  }
  const choice = chooseBrowser(available, await defaultBrowser(), process.env.NEODIRECT_BROWSER);
  if (!choice) {
    process.stdout.write(`no browser found — open ${url} yourself\n`);
    return 0;
  }

  const args = choice.app ? appArguments(url) : [url];
  if (!choice.app) {
    process.stdout.write(`${choice.command} cannot open a page as its own window — `
      + 'opening a tab instead. Install a Chromium-family browser for the window.\n');
  }
  const window = spawn(choice.command, args, { detached: true, stdio: 'ignore' });
  window.unref();
  process.stdout.write(`studio open in ${choice.command}${choice.app ? ' — its own window' : ''}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
