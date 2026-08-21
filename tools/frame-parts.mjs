/**
 * Proposes a camera move for each part of a schematic, out of where that part actually is.
 *
 *   node tools/frame-parts.mjs schematics/ore_plant.groups.json 0,-61,0
 *
 * Framing by hand means reading a bounding box out of a report, doing the trigonometry in your
 * head and being wrong by ten blocks, which you find out one take later. The bounds are already
 * written down; this reads them and puts the camera at a distance the part's own size asks for.
 *
 * What comes out is a starting point, not a finished shot. Nothing here knows what is worth
 * looking at — only where the blocks are — so the numbers get pasted into a storyboard and then
 * argued with using tools/preview.mjs.
 */

import { readFile } from 'node:fs/promises';
import { aim } from './aim.mjs';

/**
 * The bearing a part is most visible from, starting from the one that was asked for.
 *
 * The requested bearing wins unless it is genuinely bad — a shot composed on purpose should not be
 * quietly rotated because an automatic score liked the other side by a few percent.
 */
export function bestBearing(lo, size, origin, wanted, occupied, blocks) {
  const sample = blocks.length > 24
    ? blocks.filter((_, i) => i % Math.ceil(blocks.length / 24) === 0)
    : blocks;
  const targets = sample.map((p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]);
  const score = (b, lift = 0) => {
    const k = moveFor(lo, size, origin, b, occupied, lift);
    return visibility(k[k.length - 1].pos, targets, occupied);
  };
  // A low bar on purpose. The score is a good detector of "there is a wall in the way" and a poor
  // judge of "this is the nicer side": the display wall reads perfectly from a bearing this metric
  // is lukewarm about, because it counts blocks and not whether you can read them. So a bearing
  // that was chosen deliberately keeps its place unless the part is genuinely buried from there.
  const asked = score(wanted);
  if (asked >= 0.45) return { bearing: wanted, lift: 0, score: asked, asked };
  // Bearing first, then height. Something buried under a wall of display boards is not visible
  // from any compass point at eye level, and the answer is to look down at it rather than to keep
  // walking around the outside — which is what a person filming it would do.
  let best = { bearing: wanted, lift: 0, score: asked, asked };
  for (const lift of [0, 3, 6, 9, 13]) {
    for (let b = 0; b < 360; b += 30) {
      const s = score(b, lift);
      if (s > best.score + 0.05) best = { bearing: b, lift, score: s, asked };
    }
    if (best.score >= 0.6) break;
  }
  return best;
}

export function bounds(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return { lo, hi, size: hi.map((h, i) => h - lo[i] + 1) };
}

/**
 * Whether a straight run between two points clips anything.
 *
 * Sampled rather than solved, and with a margin, because the camera follows a Catmull-Rom spline
 * that bows outward between keyframes — a path whose every waypoint is clear can still bulge into
 * the build. The mod checks the real curve when a take is verified; this is the cheap version that
 * stops a shot being written that way in the first place.
 */
function clear(from, to, occupied, margin = 1) {
  const steps = Math.max(8, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 3));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = [0, 1, 2].map((k) => from[k] + (to[k] - from[k]) * t);
    for (let dx = -margin; dx <= margin; dx++) {
      for (let dy = -margin; dy <= margin; dy++) {
        for (let dz = -margin; dz <= margin; dz++) {
          const key = `${Math.floor(p[0]) + dx},${Math.floor(p[1]) + dy},${Math.floor(p[2]) + dz}`;
          if (occupied.has(key)) return false;
        }
      }
    }
  }
  return true;
}

/**
 * A three-quarter move that ends closer than it starts.
 *
 * Distance comes from the part's largest horizontal dimension: a six-block funnel row wants the
 * camera near enough to read a filter, and the boiler wants it far enough back to see all five
 * columns, and those are the same rule with a different number in it.
 *
 * With `occupied` given, the move backs off and climbs until nothing on it clips the build. Better
 * to find that here than in a verify report after the take, and much better than in the footage.
 */
export function moveFor(lo, size, origin, bearing = 215, occupied = null, lift = 0) {
  const centre = [
    origin[0] + lo[0] + size[0] / 2,
    origin[1] + lo[1] + size[1] / 2,
    origin[2] + lo[2] + size[2] / 2,
  ];
  const reach = Math.max(size[0], size[2]);

  // Try the tight framing first and give it up a step at a time. A three-block washing stage read
  // from eleven blocks away is a shot of the room it stands in.
  for (let attempt = 0; attempt < 12; attempt++) {
    const near = Math.max(4.5, reach * 0.8) + attempt * 1.2;
    const far = Math.max(8, reach * 1.5) + attempt * 1.2;
    const keyframes = keyframesFor(centre, bearing, near, far, size, lift + attempt * 0.6);
    if (!occupied) return keyframes;
    const points = keyframes.map((k) => k.pos);
    const ok = points.every((p, i) => i === 0 || clear(points[i - 1], p, occupied))
      && points.every((p) => clear(p, p, occupied));
    if (ok) return keyframes;
  }
  return keyframesFor(centre, bearing, reach * 2.4 + 8, reach * 3.2 + 10, size, lift + 6);
}

function keyframesFor(centre, bearing, near, far, size, lift) {
  return [far, (far + near) / 2, near].map((d, i) => {
    // Drift the bearing across the move so it is a slow arc rather than a push straight in.
    const angle = ((bearing + i * 14) * Math.PI) / 180;
    const height = centre[1] + Math.max(2.5, size[1] * 0.6) + lift;
    const pos = [
      round(centre[0] + d * Math.sin(angle)),
      round(height),
      round(centre[2] + d * Math.cos(angle)),
    ];
    const { yaw, pitch } = aim(pos, centre);
    return { pos, yaw, pitch };
  });
}

/**
 * How much of a part can actually be seen from a point.
 *
 * Framing by bounding box and compass bearing gets the camera to the right neighbourhood and says
 * nothing about whether the machine is behind a wall from there — which it was, twice, for a
 * washing stage whose fan faces into its own housing and a vault trio buried in the middle of the
 * plant. Rays from the camera to the part's own blocks, counted.
 */
export function visibility(from, targets, occupied) {
  let seen = 0;
  for (const t of targets) {
    const to = [t[0] + 0.5, t[1] + 0.5, t[2] + 0.5];
    const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 2);
    let blocked = false;
    // Stop one step short: the target block is itself occupied, and it is not in its own way.
    for (let i = 1; i < steps - 1; i++) {
      const f = i / steps;
      const key = [0, 1, 2].map((k) => Math.floor(from[k] + (to[k] - from[k]) * f)).join(',');
      if (occupied.has(key) && key !== t.join(',')) { blocked = true; break; }
    }
    if (!blocked) seen++;
  }
  return targets.length ? seen / targets.length : 1;
}

/** Every block the schematic fills, as a lookup the clearance check can ask. */
export function occupancy(groups, origin) {
  const set = new Set();
  for (const positions of Object.values(groups.parts)) {
    for (const p of positions) {
      set.add(`${p[0] + origin[0]},${p[1] + origin[1]},${p[2] + origin[2]}`);
    }
  }
  return set;
}

const round = (n) => Math.round(n * 10) / 10;

// Importable as a library — a storyboard generator wants `bounds` and `moveFor`, not the report.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [groupsPath, originArg] = process.argv.slice(2);
  if (!groupsPath) throw new Error('usage: node tools/frame-parts.mjs <groups.json> [originX,Y,Z]');
  const origin = (originArg ?? '0,0,0').split(',').map(Number);
  const groups = JSON.parse(await readFile(groupsPath, 'utf8'));

  for (const [name, positions] of Object.entries(groups.parts)) {
    const { lo, size } = bounds(positions);
    console.log(`\n// ${name}: ${positions.length} blocks, ${size.join('x')} at ${lo.join(',')}`);
    console.log(JSON.stringify(
      { _what: name, keyframes: moveFor(lo, size, origin, 215, occupancy(groups, origin)) }, null, 2));
  }
}

/**
 * Where to stand *inside* a machine to watch one station work.
 *
 * The move above frames a part from outside, which is right while it is being built and wrong
 * once it is running: a crusher in the middle of a plant is behind a vault wall from every
 * compass point, and backing off until the path is clear only backs off until the part is a grey
 * smudge. Following material through it means being in the gap the material travels down, and in
 * spectator that gap is a legal camera position.
 *
 * So this searches instead of solving: every air block in a shell around the station, scored by
 * how much of the station it can actually see. Air here means "no schematic block", which is the
 * same set the clearance check uses — the studio has nothing else in it.
 */
export function vantages(targets, occupied, { near = 3, far = 11, minY = -Infinity } = {}) {
  const centre = [0, 1, 2].map((k) => targets.reduce((s, t) => s + t[k] + 0.5, 0) / targets.length);
  const found = [];
  const reach = Math.ceil(far);
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const p = [Math.floor(centre[0]) + dx, Math.floor(centre[1]) + dy, Math.floor(centre[2]) + dz];
        if (p[1] < minY) continue;
        if (occupied.has(p.join(','))) continue;
        const eye = [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5];
        const d = Math.hypot(eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]);
        if (d < near || d > far) continue;
        found.push({ pos: eye, distance: round(d), seen: visibility(eye, targets, occupied) });
      }
    }
  }
  found.sort((a, b) => b.seen - a.seen || a.distance - b.distance);
  return { centre, vantages: found };
}

/** Whether a straight run between two points stays in air. Spectator ignores collision; the eye still does not. */
export function airPath(from, to, occupied) {
  const steps = Math.max(8, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 4));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = [0, 1, 2].map((k) => Math.floor(from[k] + (to[k] - from[k]) * t));
    if (occupied.has(p.join(','))) return false;
  }
  return true;
}

/**
 * A move that ends at the best interior view of a station and starts somewhere it can be reached
 * from without passing through the machine. Three keyframes, so the curve has something to ease
 * along; the middle one is on the line and therefore also in air.
 */
export function insideMove(targets, occupied, opts = {}) {
  const { centre: standCentre, vantages: ranked } = vantages(targets, occupied, opts);
  // Where the camera stands and what it points at are two different questions. Standing is decided
  // by the blocks that must be in shot at all; aim can be pulled a little wider, so a belt that
  // runs out of the bottom of the frame comes back into it.
  const centre = opts.lookAt
      ? [0, 1, 2].map((k) => opts.lookAt.reduce((s, t) => s + t[k] + 0.5, 0) / opts.lookAt.length)
      : standCentre;
  if (!ranked.length) throw new Error('no air within reach of ' + standCentre.map(round).join(','));
  const end = ranked[0];
  const start = ranked.find((v) => v.distance > end.distance + 2.5
      && v.seen >= end.seen * 0.7
      && airPath(v.pos, end.pos, occupied)) ?? ranked[1] ?? end;
  const mid = [0, 1, 2].map((k) => (start.pos[k] + end.pos[k]) / 2);
  return {
    end,
    start,
    keyframes: [start.pos, mid, end.pos].map((pos) => {
      const { yaw, pitch } = aim(pos, centre);
      return { pos: pos.map(round), yaw, pitch };
    }),
  };
}
