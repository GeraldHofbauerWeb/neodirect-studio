"""Cuts a contraption out of a saved Minecraft world and writes it as a structure file.

    python3 tools/world_clip.py scratch/world --seed -3295 9 -2122 --dry-run
    python3 tools/world_clip.py scratch/world --seed -3295 9 -2122 \\
        --out schematics/ore_plant.nbt --report schematics/ore_plant.report.json

The director already reads vanilla structure NBT, and Create's schematic table writes exactly
that, so the way to film something that was built on a server is to produce the same format from
the server's own region files. No mod, no in-game step, no upload.

What "the contraption" means here is a flood fill: start at the block nearest the seed
coordinate, walk the 26-neighbourhood, and keep going through everything that is not worldgen.
Two details matter and neither is obvious.

**Entities live in their own region files.** Since 1.17 a chunk does not contain its entities;
they are in `entities/r.X.Z.mca` under the same coordinates. A clipper that reads only `region/`
produces a Create contraption with no super glue — it looks complete and it will not assemble.

**Filters ride along in block entity NBT.** Create stores a funnel's or deployer's filter as an
item compound inside the block entity, so copying the block entity verbatim carries the whole
configuration. That only survives if the NBT keeps its tag types, which is what nbtio is for.

Water and lava are worldgen, but a bulk-washing setup without its water is not a machine, so
fluids that touch a machine block are pulled in — without being allowed to spread further, or a
single underground lake would swallow the selection.
"""

import argparse
import gzip
import json
import sys
import zlib
from collections import Counter, deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nbtio import Double, Int, List, save as nbt_save, parse as nbt_parse  # noqa: E402

# Blocks that a world generates on its own. Everything else is treated as built, which is the
# right default in a cave: it takes in modded machinery and vanilla man-made blocks alike, and
# the report shows what came along so a wrong call is visible rather than silent.
NATURAL = {
    'air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock',
    'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'smooth_basalt',
    'basalt', 'blackstone', 'netherrack', 'end_stone', 'obsidian', 'magma_block',
    'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud',
    'clay', 'gravel', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'soul_sand', 'soul_soil',
    'ice', 'packed_ice', 'blue_ice', 'snow', 'snow_block', 'powder_snow',
    'moss_block', 'moss_carpet', 'dripstone_block', 'pointed_dripstone', 'amethyst_block',
    'budding_amethyst', 'amethyst_cluster', 'small_amethyst_bud', 'medium_amethyst_bud',
    'large_amethyst_bud', 'raw_iron_block', 'raw_copper_block', 'raw_gold_block',
    'glow_lichen', 'vine', 'cave_vines', 'cave_vines_plant', 'hanging_roots', 'big_dripleaf',
    'big_dripleaf_stem', 'small_dripleaf', 'spore_blossom', 'azalea', 'flowering_azalea',
    'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'cobweb', 'sculk', 'sculk_vein',
    'sculk_catalyst', 'sculk_sensor', 'sculk_shrieker', 'short_grass', 'tall_grass', 'fern',
    'large_fern', 'dead_bush', 'brown_mushroom', 'red_mushroom', 'sugar_cane', 'lily_pad',
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
    'dark_oak_leaves', 'mangrove_leaves', 'azalea_leaves', 'flowering_azalea_leaves',
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
}

FLUIDS = {'minecraft:water', 'minecraft:lava'}

# What sits behind a block that faces a given way. A wall-mounted block points away from the thing
# holding it up, so this is where its support is.
BEHIND = {'north': (0, 0, 1), 'south': (0, 0, -1),
          'east': (-1, 0, 0), 'west': (1, 0, 0),
          'up': (0, -1, 0), 'down': (0, 1, 0)}

# Entities that are scenery rather than part of the build. Mobs wander in; the player is standing
# right there by definition; loose items are litter from whatever the machine last dropped.
DROP_ENTITIES = {'minecraft:player', 'minecraft:item', 'minecraft:experience_orb',
                 'minecraft:arrow', 'minecraft:area_effect_cloud'}


def is_natural(name):
    base = name.split(':', 1)[1] if ':' in name else name
    # Ore is worldgen whoever registered it — Create adds zinc ore to the same stone a machine is
    # dug into, and two stray blocks of it in a wall look exactly like part of the build.
    if base.endswith('_ore') or base == 'ancient_debris':
        return True
    if not name.startswith('minecraft:'):
        return False  # every other modded block is something somebody placed
    return base in NATURAL


class Region:
    """One .mca file: an 8 KiB header of sector offsets, then deflated chunk NBT."""

    def __init__(self, path):
        self.data = Path(path).read_bytes()
        self.path = path

    def chunk(self, cx, cz):
        i = ((cx & 31) + (cz & 31) * 32) * 4
        offset = int.from_bytes(self.data[i:i + 3], 'big')
        if offset == 0:
            return None
        start = offset * 4096
        length = int.from_bytes(self.data[start:start + 4], 'big')
        scheme = self.data[start + 4]
        payload = self.data[start + 5:start + 4 + length]
        # Bit 7 means the chunk outgrew the region file and lives in its own .mcc next to it.
        if scheme & 0x80:
            raise RuntimeError(f'{self.path}: chunk {cx},{cz} is external (.mcc) — copy it too')
        if scheme == 1:
            raw = gzip.decompress(payload)
        elif scheme == 2:
            raw = zlib.decompress(payload)
        elif scheme == 3:
            raw = payload
        else:
            raise RuntimeError(f'{self.path}: chunk {cx},{cz} uses compression {scheme}')
        return nbt_parse(raw)


def unpack(longs, bits, count=4096):
    """Section block indices out of packed longs.

    Since 1.16 an entry never straddles two longs — the spare high bits are simply wasted — which
    is the whole difference from the pre-1.16 packing and the one thing that makes this readable.
    """
    per_long = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for value in longs:
        unsigned = value & 0xFFFFFFFFFFFFFFFF
        for k in range(per_long):
            if len(out) >= count:
                return out
            out.append((unsigned >> (k * bits)) & mask)
    return out


class World:
    """Random access to blocks, block entities and entities across a handful of region files."""

    def __init__(self, root):
        self.root = Path(root)
        self.regions = {}
        self.entity_regions = {}
        self.chunks = {}          # (cx, cz) -> {section_y: (palette, indices|None)}
        self.block_entities = {}  # (x, y, z) -> compound
        self.loaded = set()
        self.data_version = None
        self.missing = set()

    def _region(self, cache, kind, rx, rz):
        key = (rx, rz)
        if key not in cache:
            path = self.root / kind / f'r.{rx}.{rz}.mca'
            cache[key] = Region(path) if path.exists() else None
        return cache[key]

    def _load_chunk(self, cx, cz):
        if (cx, cz) in self.loaded:
            return
        self.loaded.add((cx, cz))
        region = self._region(self.regions, 'region', cx >> 5, cz >> 5)
        if region is None:
            self.missing.add((cx >> 5, cz >> 5))
            return
        chunk = region.chunk(cx, cz)
        if chunk is None:
            return
        if self.data_version is None:
            self.data_version = int(chunk.get('DataVersion', 3955))

        sections = {}
        for section in chunk.get('sections', []):
            states = section.get('block_states')
            if not states:
                continue
            palette = [(e['Name'], dict(e.get('Properties', {}))) for e in states['palette']]
            if len(palette) == 1:
                sections[int(section['Y'])] = (palette, None)
                continue
            data = states.get('data')
            if data is None:
                sections[int(section['Y'])] = (palette, None)
                continue
            bits = max(4, (len(palette) - 1).bit_length())
            sections[int(section['Y'])] = (palette, unpack(data, bits))
        self.chunks[(cx, cz)] = sections

        for be in chunk.get('block_entities', []):
            self.block_entities[(int(be['x']), int(be['y']), int(be['z']))] = be

    def block(self, x, y, z):
        """(name, properties) at a position, or None where no chunk is loaded."""
        cx, cz = x >> 4, z >> 4
        self._load_chunk(cx, cz)
        sections = self.chunks.get((cx, cz))
        if sections is None:
            return None
        section = sections.get(y >> 4)
        if section is None:
            return 'minecraft:air', {}
        palette, indices = section
        if indices is None:
            return palette[0]
        return palette[indices[((y & 15) * 16 + (z & 15)) * 16 + (x & 15)]]

    def entities_in(self, lo, hi):
        """Every entity whose position falls inside the box, from the separate entity storage."""
        found = []
        for cx in range(lo[0] >> 4, (hi[0] >> 4) + 1):
            for cz in range(lo[2] >> 4, (hi[2] >> 4) + 1):
                region = self._region(self.entity_regions, 'entities', cx >> 5, cz >> 5)
                if region is None:
                    continue
                chunk = region.chunk(cx, cz)
                if chunk is None:
                    continue
                for entity in chunk.get('Entities', []):
                    pos = entity.get('Pos')
                    if not pos:
                        continue
                    px, py, pz = (float(c) for c in pos)
                    if (lo[0] <= px < hi[0] + 1 and lo[1] <= py < hi[1] + 1
                            and lo[2] <= pz < hi[2] + 1):
                        found.append(entity)
        return found


ORTHOGONAL = [(-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1)]

NEIGHBOURS = [(dx, dy, dz)
              for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
              if (dx, dy, dz) != (0, 0, 0)]


def find_seed(world, seed, radius=6):
    """Nearest built block to where the player was standing — their feet are usually in air."""
    sx, sy, sz = seed
    best, best_d = None, None
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            for dz in range(-radius, radius + 1):
                p = (sx + dx, sy + dy, sz + dz)
                block = world.block(*p)
                if block is None or is_natural(block[0]):
                    continue
                d = dx * dx + dy * dy + dz * dz
                if best_d is None or d < best_d:
                    best, best_d = p, d
    return best


def flood(world, start, limit, extra_natural, extra_machine):
    """Everything reachable from `start` through built blocks, plus the fluids they touch."""

    def built(name):
        if name in extra_machine:
            return True
        if name in extra_natural:
            return False
        return not is_natural(name)

    selected = {}
    queue = deque([start])
    seen = {start}
    truncated = False

    while queue:
        pos = queue.popleft()
        block = world.block(*pos)
        if block is None:
            continue
        selected[pos] = block
        if len(selected) > limit:
            truncated = True
            break
        for offset in NEIGHBOURS:
            nxt = (pos[0] + offset[0], pos[1] + offset[1], pos[2] + offset[2])
            if nxt in seen:
                continue
            nb = world.block(*nxt)
            if nb is None:
                continue
            if built(nb[0]):
                seen.add(nxt)
                queue.append(nxt)
            elif nb[0] in FLUIDS:
                # Taken along, but never expanded from: a machine keeps its water, a cave lake
                # does not get to join in.
                seen.add(nxt)
                selected[nxt] = nb

    return selected, truncated


def select_box(world, lo, hi, drop, extra_natural, extra_machine):
    """Every built block inside a box, minus the ones named in `drop`.

    A flood fill is the wrong tool once a machine is embedded in a building: the walls are built
    too, so "everything connected that is not worldgen" is the whole base, and the kinetic network
    happily bridges into the next room. A box says where the machine is; the drop list says which
    of the blocks in it are housing rather than machine, and both are recorded rather than
    guessed at from the block id.
    """

    def built(name):
        if name in drop:
            return False
        if name in extra_machine:
            return True
        if name in extra_natural:
            return False
        return not is_natural(name)

    selected = {}
    for x in range(lo[0], hi[0] + 1):
        for y in range(lo[1], hi[1] + 1):
            for z in range(lo[2], hi[2] + 1):
                block = world.block(x, y, z)
                if block and built(block[0]):
                    selected[(x, y, z)] = block

    # Fluids come second, and only where they touch something kept: the machine's water, not the
    # puddle it stands in.
    for x in range(lo[0], hi[0] + 1):
        for y in range(lo[1], hi[1] + 1):
            for z in range(lo[2], hi[2] + 1):
                if (x, y, z) in selected:
                    continue
                block = world.block(x, y, z)
                if not block or block[0] not in FLUIDS or block[0] in extra_natural:
                    continue
                # Source blocks only. Flowing water is a consequence of a source somewhere, not a
                # thing setBlock can put down: placed on its own it drains on the next tick and the
                # verifier reports a block that simply is not there.
                if block[1].get('level', '0') != '0':
                    continue
                if any((x + dx, y + dy, z + dz) in selected for dx, dy, dz in NEIGHBOURS):
                    selected[(x, y, z)] = block
    return selected


def empty_container(nbt):
    """Throws away what a container holds, and keeps what configures it.

    A machine cloned off a running server arrives with its output still in it — this one carried
    1365 quartz and 444 experience nuggets. That is the source machine's takings, not the
    episode's, and it matters more than it sounds: the bill of materials counts items held inside
    block entities, on purpose, because a deployer without its filter is not the same deployer. So
    a full chest would put the whole warehouse in the materials chest and claim you need it to
    build the thing.

    Filters live in their own key and stay. Only the inventories go.
    """
    out = {}
    for key, value in nbt.items():
        if key in ('Items', 'inventory'):
            continue
        if key == 'Inventory' and isinstance(value, dict):
            out[key] = {k: v for k, v in value.items() if k != 'Items'}
            continue
        out[key] = value
    return out


def add_support(world, selected, drop, layers=1, frame_fluids=True, frame_with=None):
    """Puts back the parts of the housing the machine cannot stand without.

    Dropping the room a machine is built into leaves the machine hanging in the air: no floor
    under the belts, and nothing behind the blocks that are screwed to a wall, which pop off the
    moment a block update reaches them. The take still reports success — the verifier looks
    immediately after placement, before those updates have propagated, and by the time anything
    has fallen the check has already passed.

    So anything in the drop list that touches a kept block comes back as support. It is the
    housing either way; the difference is that this is the part of it doing work.

    Fluids get the stricter treatment. Water that is not boxed in flows, and flowing water is
    gone by the next verification — so every fluid block, and every waterlogged block, gets
    whatever the world had on all six sides, natural stone included. The washing fan's leaf block
    is the case that matters: it is one waterlogged block in mid-air, and mid-air is exactly where
    its water does not stay.
    """
    added = Counter()

    for _ in range(layers):
        additions = {}
        for pos, (name, props) in list(selected.items()):
            # Only the two directions that hold a block up. A full six-sided shell also walls in
            # the front of the machine, and then the camera orbits a stone box: the first take with
            # one looked like a bunker with a machine rumoured to be inside it.
            wanted = [(0, -1, 0)]
            facing = props.get('facing')
            if facing in BEHIND:
                wanted.append(BEHIND[facing])
            for dx, dy, dz in wanted:
                p = (pos[0] + dx, pos[1] + dy, pos[2] + dz)
                if p in selected or p in additions:
                    continue
                block = world.block(*p)
                if block and block[0] in drop:
                    additions[p] = block
                    added[block[0]] += 1
        selected.update(additions)

    if frame_fluids:
        unframed = []
        for pos in list(selected):
            name, props = selected[pos]
            if name not in FLUIDS and props.get('waterlogged') != 'true':
                continue
            for dx, dy, dz in ORTHOGONAL:
                p = (pos[0] + dx, pos[1] + dy, pos[2] + dz)
                if p in selected:
                    continue
                block = world.block(*p)
                if block is None or block[0].endswith(':air') or block[0] in FLUIDS:
                    # Air, or more of the same pool lying outside the cut. Both are open sides, and
                    # an open side is the one thing water does not tolerate: the pool this clip
                    # takes half of drains through it within a second of the take starting. A wall
                    # goes in, or it is reported and left open.
                    if frame_with:
                        selected[p] = (frame_with, {})
                        added[frame_with] += 1
                    else:
                        unframed.append((pos, p))
                    continue
                selected[p] = block
                added[block[0]] += 1
        if unframed:
            print(f'!! {len(unframed)} fluid faces have nothing to hold them, '
                  f'e.g. {unframed[0][0]} open at {unframed[0][1]}')

    return added


def build_structure(world, selected, data_version, drop_entities, clear_containers=(),
                    reset_states=None, origin=None):
    xs = [p[0] for p in selected]
    ys = [p[1] for p in selected]
    zs = [p[2] for p in selected]
    hi = (max(xs), max(ys), max(zs))
    if origin is None:
        lo = (min(xs), min(ys), min(zs))
    else:
        # A declared origin, because local coordinates are what everything downstream is written
        # against — part boxes, showFilter positions, fill targets. Letting the corner follow the
        # selection means every re-cut silently renumbers all of them, which has now happened three
        # times and cost a take each. Out-of-range is an error rather than a shift.
        lo = tuple(origin)
        low = (min(xs), min(ys), min(zs))
        if any(low[i] < lo[i] for i in range(3)):
            raise SystemExit(f'declared origin {lo} but the selection reaches {low} — '
                             f'move the origin and shift every local coordinate that depends on it')
    size = [hi[i] - lo[i] + 1 for i in range(3)]

    palette, palette_index = [], {}
    blocks = []
    reset_states = reset_states or {}
    for pos in sorted(selected, key=lambda p: (p[1], p[2], p[0])):
        name, props = selected[pos]
        if name in reset_states:
            props = {**props, **reset_states[name]}
        key = (name, tuple(sorted(props.items())))
        if key not in palette_index:
            palette_index[key] = len(palette)
            entry = {'Name': name}
            if props:
                entry['Properties'] = dict(props)
            palette.append(entry)
        block = {
            'pos': [Int(pos[i] - lo[i]) for i in range(3)],
            'state': Int(palette_index[key]),
        }
        be = world.block_entities.get(pos)
        if be is not None:
            # Strip the absolute coordinates; the structure loader supplies its own.
            nbt = {k: v for k, v in be.items() if k not in ('x', 'y', 'z', 'keepPacked')}
            if name in clear_containers:
                nbt = empty_container(nbt)
            block['nbt'] = nbt
        blocks.append(block)

    entities = []
    dropped = Counter()
    for entity in world.entities_in(lo, hi):
        eid = entity.get('id', '?')
        if eid in drop_entities:
            dropped[eid] += 1
            continue
        px, py, pz = (float(c) for c in entity['Pos'])
        entities.append({
            'pos': List([Double(px - lo[0]), Double(py - lo[1]), Double(pz - lo[2])], 6),
            'blockPos': [Int(int(px // 1) - lo[0]), Int(int(py // 1) - lo[1]),
                         Int(int(pz // 1) - lo[2])],
            'nbt': entity,
        })

    root = {
        # Where this came from, so the director can translate the absolute positions that sit
        # inside block entity NBT. A Create display link stores the block it counts as a world
        # position; move the machine and the link points at whatever is now at those coordinates,
        # which in an empty studio world is air. The boards then show nothing and look broken, and
        # no verifier notices, because every block is exactly where it should be.
        'neodirect:sourceOrigin': [Int(c) for c in lo],
        'size': [Int(s) for s in size],
        'blocks': blocks,
        'palette': palette,
        'entities': entities,
        'DataVersion': Int(data_version or 3955),
    }
    return root, lo, hi, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('world', nargs='?', help='directory holding region/ and entities/')
    ap.add_argument('--spec', help='JSON file holding world, box, drop and seed')
    ap.add_argument('--seed', nargs=3, type=int, metavar=('X', 'Y', 'Z'),
                    help='a block coordinate inside or next to the build (flood fill)')
    ap.add_argument('--box', nargs=6, type=int, metavar=('X0', 'Y0', 'Z0', 'X1', 'Y1', 'Z1'),
                    help='clip this box instead of flood filling')
    ap.add_argument('--drop', action='append', default=[],
                    help='block id to leave behind, e.g. housing (repeatable)')
    ap.add_argument('--out', help='write the structure file here')
    ap.add_argument('--report', help='write the JSON report here')
    ap.add_argument('--limit', type=int, default=20000, help='stop after this many blocks')
    ap.add_argument('--natural', action='append', default=[],
                    help='treat this block id as worldgen (repeatable)')
    ap.add_argument('--machine', action='append', default=[],
                    help='treat this block id as built (repeatable)')
    ap.add_argument('--drop-entity', action='append', default=[],
                    help='additional entity id to leave behind (repeatable)')
    ap.add_argument('--dry-run', action='store_true', help='report only, write nothing')
    args = ap.parse_args()

    spec = json.loads(Path(args.spec).read_text()) if args.spec else {}
    world_dir = args.world or spec.get('world')
    if not world_dir:
        raise SystemExit('need a world directory, on the command line or in the spec')
    # One box or several. Several, because a machine and the boiler that drives it can sit forty
    # blocks apart with nothing but corridor between them, and one box spanning both spends five
    # hundred blocks paving a floor nobody films.
    boxes = spec.get('boxes')
    if not boxes and 'box' in spec:
        boxes = [spec['box']]
    if args.box:
        boxes = [{'from': args.box[:3], 'to': args.box[3:]}]
    seed = tuple(args.seed) if args.seed else tuple(spec['seed']) if 'seed' in spec else None
    drop = set(args.drop) | set(spec.get('drop', []))
    extra_natural = set(args.natural) | set(spec.get('natural', []))
    extra_machine = set(args.machine) | set(spec.get('machine', []))
    drop_entities = DROP_ENTITIES | set(args.drop_entity) | set(spec.get('dropEntities', []))
    out = args.out or spec.get('out')
    report_path = args.report or spec.get('report')

    world = World(world_dir)
    truncated = False

    if boxes:
        selected = {}
        for entry in boxes:
            lo_box = tuple(min(a, b) for a, b in zip(entry['from'], entry['to']))
            hi_box = tuple(max(a, b) for a, b in zip(entry['from'], entry['to']))
            part = select_box(world, lo_box, hi_box, drop, extra_natural, extra_machine)
            print(f"box {lo_box} .. {hi_box}: {len(part)} blocks")
            selected.update(part)
    elif seed:
        start = find_seed(world, seed)
        if start is None:
            raise SystemExit(f'no built block within 6 blocks of {seed} — wrong coordinate, '
                             f'or the chunk was never saved (/save-all flush)')
        print(f'seed {seed} -> nearest built block {start}  {world.block(*start)[0]}')
        selected, truncated = flood(world, start, args.limit, extra_natural, extra_machine)
        if truncated:
            print(f'!! stopped at --limit {args.limit} blocks; the selection is incomplete')
    else:
        raise SystemExit('need --box, --boxes in the spec, or --seed')

    if not selected:
        raise SystemExit('nothing selected')

    support = spec.get('support') or {}
    if support:
        before = len(selected)
        added = add_support(world, selected, drop,
                            layers=support.get('layers', 1),
                            frame_fluids=support.get('frameFluids', True),
                            frame_with=support.get('frameWith'))
        print(f'support: +{len(selected) - before} blocks  '
              + ', '.join(f'{k[k.find(":") + 1:]}:{v}' for k, v in added.most_common(6)))

    # After support, or support digs a second layer in underneath the slab it just laid.
    for entry in (boxes or []):
        floor = entry.get('floor') or (spec.get('floor') if len(boxes or []) == 1 else None)
        if not floor:
            continue
        lo_box = tuple(min(a, b) for a, b in zip(entry['from'], entry['to']))
        hi_box = tuple(max(a, b) for a, b in zip(entry['from'], entry['to']))
        y = floor['y']
        added = 0
        filled = 0
        for x in range(lo_box[0], hi_box[0] + 1):
            for z in range(lo_box[2], hi_box[2] + 1):
                if (x, y, z) in selected:
                    continue
                block = world.block(x, y, z)
                if block is None or block[0].endswith(':air') or block[0] in FLUIDS:
                    # Water and air in the floor line leave holes, and a hole in the middle of the
                    # slab is worse than one tile of the wrong stone. Only filled where a fill
                    # material is named, so the default stays "copy what is there".
                    if not floor.get('fillWith'):
                        continue
                    block = (floor['fillWith'], {})
                    filled += 1
                selected[(x, y, z)] = block
                added += 1
        print(f'floor at y={y}: +{added} blocks'
              + (f', {filled} of them filled with {floor["fillWith"]}' if filled else ''))

    # After the support pass, or it puts straight back what this is trying to take out.
    for pos in spec.get('remove', []):
        if selected.pop(tuple(pos), None) is None:
            print(f'!! remove {tuple(pos)}: nothing selected there')

    root, lo, hi, dropped = build_structure(
        world, selected, world.data_version, drop_entities,
        set(spec.get('clearContainers', [])), spec.get('resetStates'), spec.get('origin'))

    histogram = Counter(name for name, _ in selected.values())
    namespaces = Counter(name.split(':', 1)[0] for name, _ in selected.values())
    entity_histogram = Counter(e['nbt'].get('id', '?') for e in root['entities'])
    filters = {}
    for block in root['blocks']:
        nbt = block.get('nbt')
        if nbt and 'Filter' in nbt:
            item = nbt['Filter']
            filters[str(item.get('id', '?'))] = filters.get(str(item.get('id', '?')), 0) + 1

    size = [int(s) for s in root['size']]
    print(f'\n{len(selected)} blocks  {size[0]}x{size[1]}x{size[2]}  '
          f'from {lo} to {hi}  ({len(root["palette"])} states)')
    print(f'{len(root["entities"])} entities' + (f', dropped {dict(dropped)}' if dropped else ''))
    print(f'{sum(1 for b in root["blocks"] if "nbt" in b)} block entities, '
          f'{sum(filters.values())} of them filtered')

    print('\nnamespaces: ' + ', '.join(f'{k} {v}' for k, v in namespaces.most_common()))
    print('\ntop blocks:')
    for name, count in histogram.most_common(30):
        print(f'  {count:6d}  {name}')
    if entity_histogram:
        print('\nentities:')
        for name, count in entity_histogram.most_common():
            print(f'  {count:6d}  {name}')
    if filters:
        print('\nfilters:')
        for name, count in sorted(filters.items(), key=lambda kv: -kv[1]):
            print(f'  {count:6d}  {name}')

    # Touching the edge of what was copied means the build probably continues past it.
    if world.missing:
        print(f'\n!! the fill reached chunks in regions that were not copied: '
              f'{sorted(world.missing)} — re-run the pull with a larger radius')

    if args.dry_run:
        print('\n--dry-run: nothing written')
        return

    if out:
        nbt_save(root, out)
        print(f'\n-> {out}')
    if report_path:
        report = {
            'spec': args.spec,
            'box': [list(lo_box), list(hi_box)] if box else None,
            'seed': list(seed) if seed else None,
            'dropped': sorted(drop),
            'origin': list(lo),
            'size': size,
            'blocks': len(selected),
            'blockEntities': sum(1 for b in root['blocks'] if 'nbt' in b),
            'entities': dict(entity_histogram),
            'namespaces': dict(namespaces),
            'types': dict(histogram.most_common()),
            'filters': filters,
            'truncated': truncated,
        }
        Path(report_path).write_text(json.dumps(report, indent=2) + '\n')
        print(f'-> {report_path}')


if __name__ == '__main__':
    main()
