/**
 * The launcher's two decisions, which are the ones that can be wrong on a machine that is not this
 * one: which browser gets asked, and what the desktop entry says.
 *
 * Nothing here opens a window. Spawning a browser in a test would leave one behind on whatever
 * machine ran the suite, and the part worth checking is the arithmetic before the spawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { chooseBrowser, appArguments, WM_CLASS } from '../open.mjs';
import { entryText, paths, ID } from '../desktop-entry.mjs';

test('the default browser is preferred when it can open an app window', () => {
  const available = ['chromium', 'brave', 'firefox'];
  assert.equal(chooseBrowser(available, 'brave-browser.desktop').command, 'brave');
  assert.equal(chooseBrowser(available, 'chromium.desktop').command, 'chromium');
});

test('a default browser that cannot make a window still yields one that can', () => {
  const choice = chooseBrowser(['firefox', 'chromium'], 'firefox.desktop');
  assert.equal(choice.command, 'chromium');
  assert.equal(choice.app, true);
});

test('Firefox alone is a tab, and says so rather than pretending', () => {
  const choice = chooseBrowser(['firefox', 'xdg-open'], 'firefox.desktop');
  assert.equal(choice.command, 'firefox');
  assert.equal(choice.app, false);
});

test('nothing installed is nothing chosen', () => {
  assert.equal(chooseBrowser([], null), null);
});

test('an explicit choice wins, and is judged on its own name', () => {
  assert.deepEqual(chooseBrowser(['chromium'], null, '/opt/brave/brave'),
    { command: '/opt/brave/brave', app: true });
  assert.equal(chooseBrowser(['chromium'], null, '/usr/bin/firefox').app, false);
});

test('the window arguments carry the class the desktop entry names back', () => {
  const args = appArguments('http://127.0.0.1:8778/');
  assert.ok(args.includes(`--app=http://127.0.0.1:8778/`), 'the page is the app');
  assert.ok(args.includes(`--class=${WM_CLASS}`), 'its own window class');
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')),
    'its own profile, or the class is ignored by an already-running browser');
});

test('the desktop entry is complete, absolute, and matches the window class', () => {
  const text = entryText('/somewhere/studio/open.mjs', '/usr/bin/node');
  const fields = Object.fromEntries(text.split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

  assert.equal(fields.Type, 'Application');
  assert.equal(fields.Exec, '/usr/bin/node /somewhere/studio/open.mjs');
  assert.ok(path.isAbsolute(fields.Exec.split(' ')[1]), 'a menu has no working directory');
  assert.equal(fields.Icon, ID);
  assert.equal(fields.StartupWMClass, WM_CLASS);
  assert.ok(text.startsWith('[Desktop Entry]\n'));
});

test('the entry and its icons install under XDG paths', () => {
  for (const target of Object.values(paths)) {
    assert.ok(path.isAbsolute(target), `${target} is absolute`);
    assert.ok(path.basename(target).startsWith(ID), `${target} is named after the app`);
  }
  assert.ok(paths.entry.endsWith('.desktop'));
  assert.ok(paths.icon.includes(path.join('icons', 'hicolor')));
});
