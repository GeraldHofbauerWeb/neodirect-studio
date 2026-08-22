/**
 * The curve the camera flies, in the browser.
 *
 * A port of `timeline/CameraPath.java`, kept because the viewport has to draw a shot while the
 * game is closed. The director stays the authority — `camera_path` asks it whenever it is up, and
 * only falls back to this — but the two have to agree, so this follows the Java line for line:
 * uniform Catmull-Rom at tension 0.5 for position, `rotLerp` for yaw, plain lerp for pitch, and
 * the easing applied to the global t *before* the segment is chosen.
 *
 * Both easings matter. A follow take is one long linear run whose keyframes fall on the blocks it
 * is watching for; easing each leg would put keyframe three of seven somewhere other than three
 * sevenths of the way through, and the camera would arrive after the block did.
 */

export type Keyframe = { pos: [number, number, number]; yaw: number; pitch: number };
export type Pose = { pos: [number, number, number]; yaw: number; pitch: number };

export const easeInOut = (t: number) => t * t * (3 - 2 * t);

/** Uniform Catmull-Rom. It passes through every keyframe and bulges outside the box they span. */
export function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Minecraft's own angle lerp: takes the short way round, so 350° to 10° is twenty degrees. */
export function rotLerp(t: number, from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta >= 180) delta -= 360;
  if (delta < -180) delta += 360;
  return from + t * delta;
}

/** Position and rotation at `t` (0..1), after easing has already been applied to it. */
export function sample(keyframes: Keyframe[], t: number): Pose {
  const segments = keyframes.length - 1;
  const scaled = t * segments;
  const segment = Math.min(Math.floor(scaled), segments - 1);
  const local = scaled - segment;

  const p0 = keyframes[Math.max(segment - 1, 0)];
  const p1 = keyframes[segment];
  const p2 = keyframes[segment + 1];
  const p3 = keyframes[Math.min(segment + 2, keyframes.length - 1)];

  return {
    pos: [
      catmullRom(local, p0.pos[0], p1.pos[0], p2.pos[0], p3.pos[0]),
      catmullRom(local, p0.pos[1], p1.pos[1], p2.pos[1], p3.pos[1]),
      catmullRom(local, p0.pos[2], p1.pos[2], p2.pos[2], p3.pos[2]),
    ],
    yaw: rotLerp(local, p1.yaw, p2.yaw),
    pitch: p1.pitch + (p2.pitch - p1.pitch) * local,
  };
}

/** The whole move, sampled — what the viewport draws as a line. */
export function samplePath(keyframes: Keyframe[], ease: 'inOut' | 'linear' = 'inOut', steps = 160): Pose[] {
  if (keyframes.length < 2) return [];
  const out: Pose[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push(sample(keyframes, ease === 'linear' ? t : easeInOut(t)));
  }
  return out;
}

/**
 * The camera's body: a crawl-sized box with the eye near its top, not a point and not a standing
 * player. The same numbers the verifier measures and the director films from — a preview drawing
 * a different body would show green for a shot that clips.
 */
export const CAMERA_BOX = { half: 0.3, below: 0.4, above: 0.2 };

/** Which block positions the camera's body overlaps at a pose. */
export function bodyBlocks(pos: [number, number, number]): string[] {
  const out: string[] = [];
  for (let x = Math.floor(pos[0] - CAMERA_BOX.half); x <= Math.floor(pos[0] + CAMERA_BOX.half); x++) {
    for (let y = Math.floor(pos[1] - CAMERA_BOX.below); y <= Math.floor(pos[1] + CAMERA_BOX.above); y++) {
      for (let z = Math.floor(pos[2] - CAMERA_BOX.half); z <= Math.floor(pos[2] + CAMERA_BOX.half); z++) {
        out.push(`${x},${y},${z}`);
      }
    }
  }
  return out;
}
