/**
 * Builds the recording scene in OBS from scratch, over the WebSocket API.
 *
 *   node tools/obs-setup.mjs
 *
 * Two things here are not obvious and cost an afternoon to find out:
 *
 * 1. OBS must run under XWayland (`QT_QPA_PLATFORM=xcb`). As a native Wayland client the only
 *    capture source it offers is the PipeWire screen capture, which needs a portal consent dialog
 *    for every fresh setup — a human click in the middle of an otherwise scripted pipeline. Under
 *    XWayland it also offers `xcomposite_input`, which grabs an X11 window directly and needs no
 *    consent at all. Minecraft is an X11 client via XWayland, so this fits.
 *
 * 2. The window must be set by value, never picked from OBS's window list. Enumerating windows
 *    crashes OBS on this desktop — several visible windows carry no name and the plugin builds a
 *    std::string from a null pointer. Setting `capture_window` directly at creation avoids the
 *    enumeration entirely.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Obs } from './obs.mjs';

const exec = promisify(execFile);

const CONTROL = process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777';
const SCENE = 'NeoDirect';
const SOURCE = 'neodirect-game';
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;

/** Locates the game window by the pid the director reports, not by title. */
async function gameWindow() {
  const health = await (await fetch(`${CONTROL}/health`)).json();
  if (!health.pid) throw new Error('the director did not report a pid — is the dev client running?');

  const { stdout } = await exec('xdotool', ['search', '--name', 'Minecraft NeoForge']);
  for (const id of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const { stdout: owner } = await exec('xdotool', ['getwindowpid', id]).catch(() => ({ stdout: '' }));
    if (Number(owner.trim()) !== health.pid) continue;

    const { stdout: name } = await exec('xdotool', ['getwindowname', id]);
    const { stdout: klass } = await exec('xprop', ['-id', id, 'WM_CLASS']);
    const parsed = /"([^"]+)"/.exec(klass);
    return {
      id: `0x${Number(id).toString(16)}`,
      name: name.trim(),
      class: parsed ? parsed[1] : '',
    };
  }
  throw new Error(`no window belongs to the director's pid ${health.pid}`);
}

const win = await gameWindow();
console.log(`game window ${win.id} "${win.name}" (${win.class})`);

const obs = await Obs.connect();

const scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
if (!scenes.includes(SCENE)) {
  await obs.request('CreateScene', { sceneName: SCENE });
  console.log(`created scene ${SCENE}`);
}

// RemoveInput returns before OBS has actually released the name, so creating the replacement
// immediately fails with "A source already exists by that input name" — and only on every other
// run, because the removal finishes during the failed one. Wait for it to really be gone.
try {
  await obs.request('RemoveInput', { inputName: SOURCE });
  for (let attempt = 0; attempt < 40; attempt++) {
    const inputs = await obs.request('GetInputList');
    if (!inputs.inputs.some((i) => i.inputName === SOURCE)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
} catch {
  // nothing to remove
}

await obs.request('CreateInput', {
  sceneName: SCENE,
  inputName: SOURCE,
  inputKind: 'xcomposite_input',
  inputSettings: {
    // "<id>\r\n<name>\r\n<class>" — the encoding OBS itself writes for this setting.
    capture_window: `${win.id}\r\n${win.name}\r\n${win.class}`,
    show_cursor: false,
    // Decorations are not part of the shot.
    cut_top: 0, cut_left: 0, cut_right: 0, cut_bot: 0,
  },
  sceneItemEnabled: true,
});
console.log(`created ${SOURCE}`);

// OBS defaults to the QSV encoder for the Arc card, and QSV fails to initialise MFX on this
// machine ("Failed to initialize MFX") — StartRecord then reports success while no output ever
// starts, and StopRecord fails with no explanation. NVENC is unavailable too, so x264 it is:
// always present, and more than fast enough for half-minute 1080p60 clips. Switch to
// ffmpeg_vaapi_tex if CPU load ever becomes the constraint.
const OUTPUT_DIR = `${process.cwd()}/out/obs`;
await exec('mkdir', ['-p', OUTPUT_DIR]);
for (const [name, value] of [
  ['RecEncoder', 'x264'],
  ['RecQuality', 'HQ'],
  ['FilePath', OUTPUT_DIR],
]) {
  await obs.request('SetProfileParameter', {
    parameterCategory: 'SimpleOutput', parameterName: name, parameterValue: value,
  });
}
console.log(`recording: x264, HQ, into ${OUTPUT_DIR}`);

await obs.request('SetVideoSettings', {
  baseWidth: WIDTH,
  baseHeight: HEIGHT,
  outputWidth: WIDTH,
  outputHeight: HEIGHT,
  fpsNumerator: FPS,
  fpsDenominator: 1,
});
console.log(`output set to ${WIDTH}x${HEIGHT} @ ${FPS}`);

await obs.request('SetCurrentProgramScene', { sceneName: SCENE });

// Prove the capture actually sees the game rather than trusting that it does.
await new Promise((r) => setTimeout(r, 1200));
const shot = await obs.request('GetSourceScreenshot', {
  sourceName: SOURCE, imageFormat: 'png', imageWidth: 320,
});
const bytes = Buffer.from(shot.imageData.split(',')[1], 'base64');
if (bytes.length < 3000) {
  throw new Error(`capture looks blank (${bytes.length} byte screenshot) — check that the game window is not minimised`);
}
console.log(`capture verified (${bytes.length} byte test frame)`);

obs.close();
console.log('\nready: node tools/take.mjs script/pilot-b.json --capture obs');
