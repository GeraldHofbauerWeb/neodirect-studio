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

/**
 * The point a builder's crosshair would be on to put a block here: the middle of the face of
 * whatever it goes against.
 *
 * Looking at the empty air a block is about to occupy reads as the camera knowing the future.
 * Looking at the block it is placed onto is what a person does, and it also means the shot is
 * pointed at something solid before the new block exists — which is most of why it reads as real.
 *
 * Down first, because most blocks rest on something; then the sides; then up. If nothing is there
 * yet — the first block of a floor — the block's own position has to do.
 */
export function aimTarget(block, placed) {
  const sides = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const [dx, dy, dz] of sides) {
    const neighbour = [block[0] + dx, block[1] + dy, block[2] + dz];
    if (!placed.has(neighbour.join(','))) continue;
    return {
      // The shared face: the neighbour's centre, moved half a block towards the new block.
      point: [neighbour[0] + 0.5 - dx * 0.5, neighbour[1] + 0.5 - dy * 0.5, neighbour[2] + 0.5 - dz * 0.5],
      // Out of that face, towards where the block will be. Which side of it the camera has to be
      // on: you cannot click the top of a block from underneath it.
      normal: [-dx, -dy, -dz],
    };
  }
  return { point: [block[0] + 0.5, block[1] + 0.5, block[2] + 0.5], normal: null };
}

/**
 * Every position within a shell around a block that could film it.
 *
 * Two different sets, because they answer two different questions. `blocked` is where the camera
 * may not stand — everything the finished build will ever occupy, because a camera parked where a
 * block is going to appear ends up inside it. `placed` is what the rays are cast against — only
 * what exists right now, so a block that later gets walled in is still filmable at the moment it
 * goes down.
 */
function standpointsSeeing(block, placed, blocked, near, far, minY, face = null) {
  const reach = Math.ceil(far);
  const found = new Map();
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const p = [block[0] + dx, block[1] + dy, block[2] + dz];
        if (p[1] < minY || placed.has(p.join(',')) || blocked.has(p.join(','))) continue;
        const d = Math.hypot(dx, dy, dz);
        if (d < near || d > far) continue;
        const eye = [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5];
        // On the working side of the face, and not at a grazing angle to it. A camera level with
        // the top of a block sees that face edge-on and shows nothing being placed against it.
        if (face && face.normal) {
          const to = [0, 1, 2].map((k) => eye[k] - face.point[k]);
          const len = Math.hypot(to[0], to[1], to[2]) || 1;
          const facing = (to[0] * face.normal[0] + to[1] * face.normal[1] + to[2] * face.normal[2]) / len;
          if (facing < 0.35) continue;
        }
        if (visibility(eye, [block], placed) < 1) continue;
        found.set(p.join(','), eye);
      }
    }
  }
  return found;
}

/**
 * A camera that follows a build, block by block: where to stand for each one, and where to look.
 *
 * The other style here arcs past a whole assembly while its blocks appear somewhere in frame.
 * This one is shot the way a person films their own workbench — the camera is close, it is
 * pointed at the exact spot the next block goes, and it drifts from spot to spot rather than
 * panning across the room.
 *
 * Three rules, in order of who wins:
 *
 *   1. **Line of sight.** A standpoint only gets to film a block if it has an unobstructed ray to
 *      it. A camera watching a block appear behind a vault wall is watching nothing.
 *   2. **Stay put.** Among the standpoints that can see it, the one nearest where the camera
 *      already is wins by a wide margin. That is what turns a per-block choice into a slow glide
 *      instead of a series of jumps.
 *   3. **Frame it.** Only then does distance and a level-ish angle break the tie.
 *
 * Rays are cast against the build **as it stands at that moment**, not the finished thing. Not
 * academic: half the boiler ends up walled in by the other half, and measured against the finished
 * plant those blocks are invisible from everywhere. At the moment each is placed it is in plain
 * sight, which is the only moment that matters. `placed` grows as the walk proceeds, so a caller
 * filming several assemblies in order passes one set through them all.
 *
 * A shot is marked `cut` when the camera cannot reach this standpoint from the last one calmly —
 * either the hop is too far to cross in one block's worth of time, or the way is through the
 * build. A cut is honest; a swoop is not, and neither is a camera shouldering through a wall.
 *
 * `neverStand` is everything the finished build will occupy. The camera is kept out of all of it,
 * even where the block has not arrived yet: standing in the puddle the boiler is about to be built
 * around is legal at the time and looks like a mistake ten seconds later.
 */
export function placementShots(positions, placed, origin,
    { near = 2.5, far = 7, ideal = 4, glide = 2.2, neverStand = new Set() } = {}) {
  const world = (p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]];
  const minY = origin[1] + 1;
  const everSolid = (a, b) => ({ has: (k) => a.has(k) || b.has(k) });
  const shots = [];
  let previous = null;

  for (let i = 0; i < positions.length; i++) {
    const block = world(positions[i]);
    const face = aimTarget(block, placed);
    const target = face.point;
    let seeing = standpointsSeeing(block, placed, neverStand, near, far, minY, face);
    // If honouring the face leaves nowhere at all, take any view of it rather than none.
    if (!seeing.size) seeing = standpointsSeeing(block, placed, neverStand, near, far, minY);

    let eye = null;
    if (seeing.size) {
      let best = null;
      for (const candidate of seeing.values()) {
        const d = Math.hypot(candidate[0] - target[0], candidate[1] - target[1], candidate[2] - target[2]);
        const { pitch } = aim(candidate, target);
        const travel = previous ? distance3(previous, candidate) : 0;
        const score = -1.2 * travel - Math.abs(d - ideal) - Math.max(0, Math.abs(pitch) - 35) / 20;
        if (!best || score > best.score) best = { candidate, score };
      }
      eye = best.candidate;
    } else {
      // Nowhere can see it. Rare, and not worth failing a take over — hold where we are.
      eye = previous ?? [target[0], target[1] + 3, target[2] + 5];
    }

    // Glide only where the body can actually travel — and measured against everything the build
    // will ever contain, not just what stands there now. A glide is a second or two long; a block
    // that arrives during it would otherwise swallow the camera on the way past.
    const cut = previous !== null
      && (distance3(previous, eye) > glide || !bodyPathClear(previous, eye, everSolid(placed, neverStand)));
    shots.push({ index: i, pos: eye.map(round), aim: aim(eye, target), cut, blind: !seeing.size });
    previous = eye;
    placed.add(block.join(','));
  }
  return shots;
}

const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Whether the camera's whole body fits along a straight glide.
 *
 * A point-sized check passes a path that cuts the corner off a block, and the camera is not a
 * point: it films from a 0.6 cube, so clipping a corner puts a face across the lens for a frame.
 * The same box the mod's clearance check measures — keep the two in step.
 */
function bodyPathClear(from, to, blocked) {
  const steps = Math.max(6, Math.ceil(distance3(from, to) * 6));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = [0, 1, 2].map((k) => from[k] + (to[k] - from[k]) * t);
    for (const dx of [-0.3, 0.3]) {
      for (const dy of [-0.4, 0.2]) {
        for (const dz of [-0.3, 0.3]) {
          const key = `${Math.floor(p[0] + dx)},${Math.floor(p[1] + dy)},${Math.floor(p[2] + dz)}`;
          if (blocked.has(key)) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Where water will be, as opposed to where the schematic says it is.
 *
 * The clip takes source blocks only — flowing water regenerates from them, and cloning the flow
 * would have frozen a snapshot of a thing that is supposed to move. That is right for the build
 * and wrong for the camera: a standpoint the schematic calls empty can be knee-deep by the time a
 * take reaches it, and a shot filmed from inside water is a blue screen.
 *
 * So the spread is derived rather than looked up. Deliberately generous — sideways seven from any
 * source, and falling water spreads seven again wherever it lands — because over-estimating costs
 * a camera position and under-estimating costs a shot.
 */
export function waterReach(groups, origin, { spread = 7 } = {}) {
  const solid = occupancy(groups, origin);
  const sources = [];
  for (const [name, positions] of Object.entries(groups.parts)) {
    const ids = groups.ids?.[name];
    if (!ids) continue;
    positions.forEach((p, i) => {
      if (ids[i] === 'minecraft:water') {
        sources.push([p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]);
      }
    });
  }
  if (!sources.length) return new Set();

  // Bounded by the build it belongs to. Unbounded, one pool at the edge of the floor floods the
  // whole plain and the camera has nowhere left to stand.
  const all = Object.values(groups.parts).flat().map((p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]);
  const { lo, hi } = bounds(all);
  const inside = (p) => [0, 1, 2].every((k) => p[k] >= lo[k] - 2 && p[k] <= hi[k] + 2);

  const wet = new Set(sources.map((p) => p.join(',')));
  let frontier = sources.map((p) => ({ p, budget: spread }));
  while (frontier.length) {
    const next = [];
    for (const { p, budget } of frontier) {
      const steps = [[[0, -1, 0], spread]];
      if (budget > 0) {
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) steps.push([d, budget - 1]);
      }
      for (const [[dx, dy, dz], left] of steps) {
        const q = [p[0] + dx, p[1] + dy, p[2] + dz];
        const key = q.join(',');
        if (!inside(q) || wet.has(key) || solid.has(key)) continue;
        wet.add(key);
        next.push({ p: q, budget: left });
      }
    }
    frontier = next;
  }
  return wet;
}

/**
 * The curve the mod will actually fly, in JavaScript.
 *
 * Mirrors {@code CameraPath.sample} in the mod. Two implementations of one curve is a thing to be
 * uneasy about, and the mod's own comment says why it is worth it anyway: the path bulges outside
 * the box its keyframes span, so a shot whose every waypoint is clear can still bow into a wall.
 * Checking that here means it never gets written down in the first place; the mod checks it again
 * against the real world before a take rolls.
 */
export function samplePath(keyframes, t) {
  const segments = keyframes.length - 1;
  const scaled = t * segments;
  const segment = Math.min(Math.floor(scaled), segments - 1);
  const local = scaled - segment;
  const at = (i) => keyframes[Math.max(0, Math.min(keyframes.length - 1, i))].pos;
  const p0 = at(segment - 1);
  const p1 = at(segment);
  const p2 = at(segment + 1);
  const p3 = at(segment + 2);
  return [0, 1, 2].map((k) => 0.5 * ((2 * p1[k])
    + (-p0[k] + p2[k]) * local
    + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * local * local
    + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * local * local * local));
}

/** Whether the camera's body stays clear along the whole curve, bulges included. */
export function curveClear(keyframes, blocked, samples = 24) {
  if (keyframes.length < 2) return true;
  const steps = samples * (keyframes.length - 1);
  for (let i = 0; i <= steps; i++) {
    const p = samplePath(keyframes, i / steps);
    for (const dx of [-0.3, 0.3]) {
      for (const dy of [-0.4, 0.2]) {
        for (const dz of [-0.3, 0.3]) {
          if (blocked.has(`${Math.floor(p[0] + dx)},${Math.floor(p[1] + dy)},${Math.floor(p[2] + dz)}`)) {
            return false;
          }
        }
      }
    }
  }
  return true;
}
