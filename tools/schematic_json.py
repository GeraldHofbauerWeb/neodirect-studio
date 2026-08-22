"""Dumps a schematic as JSON, so something other than the game can look at it.

    python3 tools/schematic_json.py schematics/ore_plant.nbt
    python3 tools/schematic_json.py schematics/ore_plant.nbt --summary
    python3 tools/schematic_json.py schematics/ore_plant.nbt --nbt   # block entities as well

Structure NBT is a compressed binary format with a palette, which is the right shape for the game
and the wrong shape for a viewport: drawing the build in a browser means an indexable list of
blocks with their names and their block states already resolved. The reading is `tools/nbtio.py`,
same as everything else here — this only rearranges what it returns.

The index of a block is its position in the schematic's own `blocks` list, which is what a `place`
cue means by an index and what the director counts. Order is not touched for that reason.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nbtio  # noqa: E402

AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}


def plain(value):
    """NBT tag wrappers back to plain Python, so `json` can write them."""
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, nbtio.List):
        return [plain(v) for v in value.values]
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, (nbtio.Byte, nbtio.Short, nbtio.Int, nbtio.Long)):
        return int(value)
    if isinstance(value, (nbtio.Float, nbtio.Double)):
        return float(value)
    if isinstance(value, (nbtio.ByteArray, nbtio.IntArray, nbtio.LongArray)):
        return [int(v) for v in value.values]
    return value


def read(path, want_nbt=False):
    root = nbtio.load(path)
    palette = root.get('palette')
    if palette is None and 'palettes' in root:
        palette = root['palettes'][0]
    if palette is None:
        raise SystemExit(f'{path}: no palette — is this a structure NBT file?')

    # The index a cue means is the index the director counts, so this has to arrive in the
    # director's order and with the director's blocks: genuine air dropped — by *name*, because
    # Create's crushing wheel controller is air-like and essential — and then sorted bottom-up,
    # then by distance from the corner. A viewport that numbered blocks its own way would point at
    # a different block than the cue it is showing.
    #
    # The one thing that cannot be reproduced away from the game is the registry check: a block
    # whose mod is missing resolves to air there and is skipped. Here every non-air name counts,
    # and whether the instance actually knows it is what the project doctor asks the running game.
    raw = []
    for index, block in enumerate(root['blocks']):
        entry = palette[int(block['state'])]
        name = entry['Name']
        properties = dict(entry.get('Properties', {}))
        raw.append({
            'raw': index,
            'pos': [int(c) for c in block['pos']],
            'id': name,
            'air': name in AIR,
            **({'properties': {k: str(v) for k, v in properties.items()}} if properties else {}),
            **({'hasNbt': True} if 'nbt' in block else {}),
            **({'nbt': plain(block['nbt'])} if want_nbt and 'nbt' in block else {}),
        })

    blocks = [b for b in raw if not b['air']]
    blocks.sort(key=lambda b: (b['pos'][1], b['pos'][2], b['pos'][0]))
    for index, block in enumerate(blocks):
        block['i'] = index

    entities = []
    for entity in root.get('entities', []) or []:
        nbt = entity.get('nbt', {})
        entities.append({
            'pos': [float(c) for c in entity['pos']],
            'id': nbt.get('id', '?'),
            **({'nbt': plain(nbt)} if want_nbt else {}),
        })

    size = [int(c) for c in root.get('size', [0, 0, 0])]
    origin = root.get('neodirect:sourceOrigin')
    counts = Counter(b['id'] for b in blocks)
    return {
        'schematic': str(path),
        'size': size,
        'sourceOrigin': [int(c) for c in origin] if origin is not None else None,
        'blocks': len(blocks),
        'air': len(raw) - len(blocks),
        'namespaces': sorted({b['id'].split(':')[0] for b in blocks}),
        'types': dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        'entities': entities,
        'blockList': blocks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('schematic')
    parser.add_argument('--summary', action='store_true', help='counts and sizes only, no block list')
    parser.add_argument('--nbt', action='store_true', help='include block-entity and entity NBT')
    args = parser.parse_args()

    data = read(Path(args.schematic), want_nbt=args.nbt)
    if args.summary:
        data.pop('blockList')
        data['entities'] = len(data['entities'])
    json.dump(data, sys.stdout)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
