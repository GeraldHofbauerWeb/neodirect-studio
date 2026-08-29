#!/usr/bin/env node
/**
 * Puts the studio in the application menu, so it opens like anything else on the machine.
 *
 *   node studio/desktop-entry.mjs             install
 *   node studio/desktop-entry.mjs --remove    take it out again
 *   node studio/desktop-entry.mjs --print     show what would be written, and write nothing
 *
 * A separate step from the launcher on purpose: this one writes into the user's home, and a thing
 * that puts itself in your menu the first time you run it is a thing you did not ask for.
 *
 * The entry points at `studio/open.mjs` by absolute path, so it keeps working from a menu that has
 * no idea where the repository is — but it also means moving the repository means running this
 * again. `StartupWMClass` has to match the `--class` the launcher passes, or the window manager
 * files the studio's window under the browser instead of under this icon.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WM_CLASS } from './open.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DATA = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');

export const ID = 'neodirect-studio';
export const paths = {
  entry: path.join(DATA, 'applications', `${ID}.desktop`),
  icon: path.join(DATA, 'icons', 'hicolor', 'scalable', 'apps', `${ID}.svg`),
  iconPng: path.join(DATA, 'icons', 'hicolor', '512x512', 'apps', `${ID}.png`),
};

/**
 * The entry itself.
 *
 * @param launcher  absolute path to open.mjs
 * @param node      the interpreter to run it with, spelled out rather than left to a shebang so a
 *                  menu with a threadbare PATH still finds the right one
 */
export function entryText(launcher, node) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=NeoDirect Studio',
    'Comment=Write, frame, film and check an episode of scripted Minecraft',
    `Exec=${node} ${launcher}`,
    `Icon=${ID}`,
    'Terminal=false',
    'Categories=Development;AudioVideo;Video;',
    'Keywords=minecraft;recording;timeline;camera;',
    // Must equal the --class the launcher passes, or the window lands under the browser's icon.
    `StartupWMClass=${WM_CLASS}`,
    'SingleMainWindow=true',
    '',
  ].join('\n');
}

async function refreshMenu() {
  await new Promise((done) => {
    const probe = spawn('update-desktop-database', [path.join(DATA, 'applications')], { stdio: 'ignore' });
    probe.on('exit', done);
    probe.on('error', done);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const text = entryText(path.join(HERE, 'open.mjs'), process.execPath);

  if (argv.includes('--print')) {
    process.stdout.write(text);
    return 0;
  }

  if (argv.includes('--remove')) {
    for (const target of Object.values(paths)) await rm(target, { force: true });
    await refreshMenu();
    process.stdout.write(`removed ${paths.entry}\n`);
    return 0;
  }

  for (const target of Object.values(paths)) await mkdir(path.dirname(target), { recursive: true });
  await writeFile(paths.entry, text, { mode: 0o755 });
  await writeFile(paths.icon, await readFile(path.join(HERE, 'web', 'public', 'icon.svg')));
  await writeFile(paths.iconPng, await readFile(path.join(HERE, 'web', 'public', 'icon-512.png')));
  await refreshMenu();

  process.stdout.write(`installed ${paths.entry}\n`);
  process.stdout.write('"NeoDirect Studio" is in the application menu — it starts the server if it '
    + 'is not already up.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
