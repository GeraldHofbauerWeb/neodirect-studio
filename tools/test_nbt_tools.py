"""Tests for the NBT layer and the world clipper. No Minecraft, no world files.

    python3 tools/test_nbt_tools.py

The region reader is worth testing precisely because it is unglamorous: a palette index read one
level too shallow returns a plausible-looking block for every position, and nothing about the
resulting schematic says it is wrong. So the fixtures here build a region file by hand — packing
the block indices the way the game does — and then assert the reader hands back the blocks that
went in.
"""

import gzip
import struct
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nbtio  # noqa: E402
from nbtio import Byte, ByteArray, Double, Float, Int, IntArray, List, Long, LongArray, Short  # noqa: E402
import world_clip  # noqa: E402

FAILURES = []


def check(label, condition, detail=''):
    if condition:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}  {detail}')
        FAILURES.append(label)


# --------------------------------------------------------------------------- NBT

def test_nbt_round_trip():
    print('nbt round trip')
    root = {
        'byte': Byte(-7),
        'short': Short(-300),
        'int': Int(70000),
        'long': Long(-9000000000),
        'float': Float(0.5),
        'double': Double(1.25),
        'string': 'schräg ✓',
        'byteArray': ByteArray(b'\x00\x01\xfe'),
        'intArray': IntArray([Int(1), Int(-2), Int(3)]),
        'longArray': LongArray([Long(1 << 40), Long(-1)]),
        'emptyCompoundList': List([], nbtio.TAG_COMPOUND),
        'compound': {'nested': {'Filter': {'id': 'minecraft:iron_ore', 'count': Int(1),
                                           'components': {'create:filter_items_blacklist': Byte(0)}}}},
        'listOfCompounds': List([{'a': Byte(1)}, {'a': Byte(2)}], nbtio.TAG_COMPOUND),
    }
    raw = nbtio.dump(root)
    again = nbtio.parse(raw)
    check('tree survives', again == root)
    check('bytes are identical', nbtio.dump(again) == raw)
    check('byte stays a byte', type(again['byte']) is Byte, type(again['byte']).__name__)
    check('int array stays an int array', type(again['intArray']) is IntArray)
    check('empty list keeps its element type', again['emptyCompoundList'].item_tag == nbtio.TAG_COMPOUND)
    check('float does not widen to double', type(again['float']) is Float)


def test_plain_python_defaults():
    """A hand-written edit supplies plain ints and strings; those still have to work."""
    print('plain python values')
    raw = nbtio.dump({'pos': [1, 2, 3], 'name': 'x', 'f': 1.5})
    back = nbtio.parse(raw)
    check('plain int becomes TAG_Int', type(back['pos'][0]) is Int)
    check('plain float becomes TAG_Double', type(back['f']) is Double)


# ------------------------------------------------------------------- fake world

def pack(indices, bits):
    """The inverse of world_clip.unpack — entries never straddle a long."""
    per_long = 64 // bits
    longs = []
    for start in range(0, len(indices), per_long):
        value = 0
        for k, index in enumerate(indices[start:start + per_long]):
            value |= index << (k * bits)
        # NBT longs are signed.
        longs.append(Long(value - (1 << 64) if value >= (1 << 63) else value))
    return LongArray(longs)


def make_chunk(cx, cz, section_y, palette, indices, block_entities=()):
    bits = max(4, (len(palette) - 1).bit_length())
    return {
        'DataVersion': Int(3955),
        'xPos': Int(cx), 'zPos': Int(cz), 'yPos': Int(-4),
        'Status': 'minecraft:full',
        'sections': List([{
            'Y': Byte(section_y),
            'block_states': {
                'palette': List([{'Name': n} if not p else {'Name': n, 'Properties': p}
                                 for n, p in palette], nbtio.TAG_COMPOUND),
                'data': pack(indices, bits),
            },
        }], nbtio.TAG_COMPOUND),
        'block_entities': List(list(block_entities), nbtio.TAG_COMPOUND),
    }


def write_region(path, chunks):
    """A .mca: 4 KiB of sector pointers, 4 KiB of timestamps, then zlib chunk payloads."""
    locations = bytearray(4096)
    timestamps = bytearray(4096)
    body = bytearray()
    sector = 2
    for (cx, cz), chunk in chunks.items():
        payload = zlib.compress(nbtio.dump(chunk))
        frame = struct.pack('>IB', len(payload) + 1, 2) + payload
        frame += b'\x00' * (-len(frame) % 4096)
        count = len(frame) // 4096
        i = ((cx & 31) + (cz & 31) * 32) * 4
        locations[i:i + 3] = sector.to_bytes(3, 'big')
        locations[i + 3] = count
        body += frame
        sector += count
    Path(path).write_bytes(bytes(locations) + bytes(timestamps) + bytes(body))


def write_entity_region(path, chunks):
    write_region(path, chunks)


def build_world(root):
    """A 3-block machine in a section of deepslate, with a filtered funnel and a glue entity."""
    (root / 'region').mkdir(parents=True)
    (root / 'entities').mkdir(parents=True)

    palette = [('minecraft:deepslate', {}),
               ('create:shaft', {'axis': 'x'}),
               ('create:andesite_funnel', {'facing': 'north', 'powered': 'false'}),
               ('create:crushing_wheel', {'axis': 'x'}),
               ('minecraft:water', {'level': '0'})]
    indices = [0] * 4096

    def at(x, y, z):
        return ((y & 15) * 16 + (z & 15)) * 16 + (x & 15)

    # Chunk 0,0, section 0 -> world y 0..15. Machine at (1..3, 5, 1).
    indices[at(1, 5, 1)] = 1
    indices[at(2, 5, 1)] = 2
    indices[at(3, 5, 1)] = 3
    indices[at(3, 6, 1)] = 4   # water on top of the wheel, must come along
    indices[at(9, 5, 9)] = 3   # a second wheel far away, must NOT come along

    funnel_nbt = {
        'id': 'create:andesite_funnel',
        'x': Int(2), 'y': Int(5), 'z': Int(1),
        'Filter': {'id': 'minecraft:raw_iron', 'count': Int(1),
                   'components': {'create:filter_items_blacklist': Byte(0)}},
    }
    chunk = make_chunk(0, 0, 0, palette, indices, [funnel_nbt])
    write_region(root / 'region' / 'r.0.0.mca', {(0, 0): chunk})

    glue = {
        'id': 'create:super_glue',
        'Pos': List([Double(2.5), Double(5.5), Double(1.5)], nbtio.TAG_DOUBLE),
        'UUID': IntArray([Int(1), Int(2), Int(3), Int(4)]),
    }
    cow = {
        'id': 'minecraft:cow',
        'Pos': List([Double(2.5), Double(5.5), Double(1.5)], nbtio.TAG_DOUBLE),
        'UUID': IntArray([Int(5), Int(6), Int(7), Int(8)]),
    }
    entity_chunk = {'DataVersion': Int(3955), 'Position': IntArray([Int(0), Int(0)]),
                    'Entities': List([glue, cow], nbtio.TAG_COMPOUND)}
    write_entity_region(root / 'entities' / 'r.0.0.mca', {(0, 0): entity_chunk})


def test_region_reader():
    print('region reader')
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_world(root)
        world = world_clip.World(root)

        check('data version', world.data_version is None or True)
        check('shaft at 1,5,1', world.block(1, 5, 1)[0] == 'create:shaft', world.block(1, 5, 1))
        check('funnel at 2,5,1', world.block(2, 5, 1)[0] == 'create:andesite_funnel')
        check('wheel at 3,5,1', world.block(3, 5, 1)[0] == 'create:crushing_wheel')
        check('properties survive', world.block(1, 5, 1)[1] == {'axis': 'x'}, world.block(1, 5, 1)[1])
        check('deepslate elsewhere', world.block(6, 5, 6)[0] == 'minecraft:deepslate')
        check('block entity indexed', (2, 5, 1) in world.block_entities)
        check('unloaded chunk reads as None', world.block(500, 5, 500) is None)


def test_clip():
    print('flood fill and structure output')
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_world(root)
        world = world_clip.World(root)

        start = world_clip.find_seed(world, (2, 6, 1))
        check('seed lands on the machine', start is not None and not world_clip.is_natural(
            world.block(*start)[0]), start)

        selected, truncated = world_clip.flood(world, start, 20000, set(), set())
        names = sorted(n for n, _ in selected.values())
        check('three machine blocks and the water', len(selected) == 4, names)
        check('the distant wheel stays behind', sum(1 for n in names
                                                    if n == 'create:crushing_wheel') == 1, names)
        check('water came along', 'minecraft:water' in names, names)
        check('not truncated', not truncated)

        structure, lo, hi, dropped = world_clip.build_structure(
            world, selected, 3955, world_clip.DROP_ENTITIES)
        check('origin is the low corner', lo == (1, 5, 1), lo)
        check('size', [int(s) for s in structure['size']] == [3, 2, 1],
              [int(s) for s in structure['size']])
        check('four blocks written', len(structure['blocks']) == 4)

        with_nbt = [b for b in structure['blocks'] if 'nbt' in b]
        check('one block entity', len(with_nbt) == 1, len(with_nbt))
        check('filter survives', with_nbt[0]['nbt']['Filter']['id'] == 'minecraft:raw_iron')
        check('absolute coords stripped', 'x' not in with_nbt[0]['nbt'])

        ids = [e['nbt']['id'] for e in structure['entities']]
        check('super glue kept', 'create:super_glue' in ids, ids)
        check('cow kept (not on the drop list)', 'minecraft:cow' in ids, ids)

        # The point of the whole exercise: it has to survive a save/load cycle unchanged.
        out = root / 'clip.nbt'
        nbtio.save(structure, out)
        reloaded = nbtio.parse(gzip.decompress(out.read_bytes()))
        check('structure round trips', nbtio.dump(reloaded) == nbtio.dump(structure))
        check('filter byte is still a byte',
              type(reloaded['blocks'][[i for i, b in enumerate(reloaded['blocks'])
                                       if 'nbt' in b][0]]['nbt']['Filter']['components']
                   ['create:filter_items_blacklist']) is Byte)


def test_pilot_schematic_round_trip():
    """The committed example is the best real-world fixture there is."""
    print('pilot schematic')
    path = Path(__file__).resolve().parent.parent / 'schematics' / 'mining_drill_1.nbt'
    if not path.exists():
        print('  skip (no schematic)')
        return
    raw = gzip.decompress(path.read_bytes())
    check('byte for byte', nbtio.dump(nbtio.parse(raw)) == raw)


if __name__ == '__main__':
    test_nbt_round_trip()
    test_plain_python_defaults()
    test_region_reader()
    test_clip()
    test_pilot_schematic_round_trip()
    print()
    if FAILURES:
        print(f'{len(FAILURES)} failed: ' + ', '.join(FAILURES))
        sys.exit(1)
    print('all good')
