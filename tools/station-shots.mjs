/**
 * Where a station of the running plant is filmed from.
 *
 * Shared by the two takes that show material moving: the live-flow run-through and the narrated
 * episode's last beat. The framing is the same question in both — where can you stand and see the
 * crusher work — and answering it twice invites the two answers to drift.
 *
 * Two shapes. Most stations are filmed from outside on a bearing, arcing in. The crusher has no
 * outside: it sits in the middle of the plant with the vault wall on its south side, and every
 * exterior bearing reads it as a grey smudge behind a chest. That one is filmed from a gap inside
 * the machine, which is a legal place to stand because the camera does not collide.
 */

import { bounds, insideMove, moveFor, visibility } from './frame-parts.mjs';

export function stationShot(station, occupied, origin, framing) {
  const world = (p) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]];

  if (station.inside) {
    const move = insideMove(station.blocks.map(world), occupied, {
      ...station.inside,
      minY: origin[1] + 1,
      lookAt: (station.lookAt ?? station.blocks).map(world),
    });
    const targets = (station.lookAt ?? station.blocks).map(world);
    return { keyframes: move.keyframes, seen: visibility(move.end.pos, targets, occupied) };
  }

  const { lo, size } = bounds(station.blocks);
  // The arc is subtracted so the *last* frame lands on the bearing that was asked for, rather than
  // starting there and swinging past it.
  const keyframes = moveFor(lo, size, origin, station.bearing - framing.arc, occupied, station.lift ?? 0);
  const targets = station.blocks.map(world);
  return { keyframes, seen: visibility(keyframes[keyframes.length - 1].pos, targets, occupied) };
}
