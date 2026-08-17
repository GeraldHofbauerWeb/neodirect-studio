/**
 * Screen capture straight off the game window with ffmpeg, as an alternative to OBS.
 *
 * Minecraft runs through XWayland even on a Wayland session, so its window is a normal X11
 * drawable and `x11grab` can take it directly. That means a take can be shot with nothing
 * installed beyond ffmpeg — no OBS, no sudo, no compositor portal dance. OBS remains the better
 * choice once scenes, overlays or a webcam enter the picture; this is the zero-setup path.
 *
 * Exposes the same start/stop shape as obs.mjs so tools/take.mjs can use either.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WINDOW_TITLE = process.env.NEODIRECT_WINDOW ?? 'Minecraft NeoForge';

/**
 * Finds the game window belonging to the client we are actually driving.
 *
 * Matching on the window title alone is not safe: every Minecraft on the machine carries the same
 * title, and a second one — the modpack instance, a leftover from an earlier session — will
 * happily be recorded instead. So the director reports its own process id over /health and we
 * match the window to that process.
 */
export async function findWindow({ title = WINDOW_TITLE, control } = {}) {
  let pid = null;
  if (control) {
    try {
      pid = (await (await fetch(`${control}/health`)).json()).pid ?? null;
    } catch {
      // Fall through to title matching and warn below.
    }
  }

  const { stdout } = await run('xdotool', ['search', '--name', title]).catch(() => ({ stdout: '' }));
  const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`no window matching "${title}" — is the dev client running?`);

  const windows = [];
  for (const id of ids) {
    try {
      const { stdout: geom } = await run('xdotool', ['getwindowgeometry', '--shell', id]);
      const g = Object.fromEntries(geom.trim().split('\n').map((l) => l.split('=')));
      const { stdout: owner } = await run('xdotool', ['getwindowpid', id]).catch(() => ({ stdout: '' }));
      windows.push({ id, pid: Number(owner.trim()) || null, x: +g.X, y: +g.Y, width: +g.WIDTH, height: +g.HEIGHT });
    } catch {
      // Window vanished between listing and querying; ignore.
    }
  }
  if (!windows.length) throw new Error(`could not read geometry for any "${title}" window`);

  if (pid !== null) {
    const mine = windows.find((w) => w.pid === pid);
    if (mine) return mine;
    throw new Error(`the director reports pid ${pid} but no window belongs to it (found: ${windows.map((w) => `${w.id}/${w.pid}`).join(', ')})`);
  }

  if (windows.length > 1) {
    console.warn(`warning: ${windows.length} windows match "${title}" and the director did not report a pid — picking the largest, which may be the wrong game.`);
  }
  windows.sort((a, b) => b.width * b.height - a.width * a.height);
  return windows[0];
}

export class Capture {
  #child;
  #path;

  static async start(path, { fps = 60, window, control } = {}) {
    const capture = new Capture();
    const win = window ?? (await findWindow({ control }));
    await mkdir(dirname(path), { recursive: true });

    // x11grab copies a screen region, not a window: anything overlapping the game ends up in the
    // recording. Raise it first, and give the compositor a moment to actually do so.
    await run('xdotool', ['windowraise', win.id]).catch(() => {});
    await run('xdotool', ['windowactivate', win.id]).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    // Even dimensions: h264 chroma subsampling cannot encode an odd width or height.
    const width = win.width - (win.width % 2);
    const height = win.height - (win.height % 2);

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', String(fps),
      '-video_size', `${width}x${height}`,
      '-i', `${process.env.DISPLAY ?? ':0'}+${win.x},${win.y}`,
      // ultrafast keeps the grabber from ever becoming the bottleneck; the clip is short and gets
      // re-encoded during the mux anyway if it needs to be.
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      path,
    ];

    capture.#path = path;
    capture.#child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    capture.#child.stderr.on('data', (d) => (stderr += d));
    capture.#child.on('close', (code) => {
      if (code !== 0 && code !== 255) console.warn(`ffmpeg exited ${code}: ${stderr.slice(-500)}`);
    });

    console.log(`capturing ${width}x${height} at ${win.x},${win.y} -> ${path}`);
    return capture;
  }

  /** Asks ffmpeg to finish the file cleanly rather than killing it mid-write. */
  stop() {
    return new Promise((resolve) => {
      if (!this.#child || this.#child.exitCode !== null) return resolve(this.#path);
      this.#child.on('close', () => resolve(this.#path));
      this.#child.stdin.write('q');
      this.#child.stdin.end();
      setTimeout(() => this.#child.kill('SIGINT'), 3000);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await findWindow({ control: process.env.NEODIRECT_CONTROL ?? 'http://127.0.0.1:8777' }));
}
