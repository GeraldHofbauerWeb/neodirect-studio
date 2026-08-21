"""Checks a storyboard against its schematic, before anything is rendered or recorded.

    python3 tools/check-storyboard.py script/ore-plant.storyboard.json

Everything here is a mistake you would otherwise find by watching the finished video: a filter cue
pointing at a block that has no filter, a fill cue aimed at a belt, a part name with a typo, a
creative motor placed inside the build it is supposed to drive. None of them fails a take — the
director places what it can and the log looks fine.

Camera clearance is deliberately not checked here. The mod already does it properly, against the
curve rather than the keyframes, and a second implementation would only be a second thing to keep
in step with the first.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nbtio  # noqa: E402

CONTAINERS = {'minecraft:chest', 'minecraft:barrel', 'quark:oak_chest', 'create:item_vault',
              'create:basin', 'create:depot', 'minecraft:hopper', 'create:deployer'}

problems = []


def fail(message):
    problems.append(message)


def main(path):
    storyboard = json.loads(Path(path).read_text())
    here = Path(path).parent
    schematic_dir = Path(__file__).resolve().parent.parent / 'schematics'

    root = nbtio.load(schematic_dir / storyboard['schematic'])
    palette = root['palette']
    blocks = {}
    for block in root['blocks']:
        pos = tuple(int(c) for c in block['pos'])
        blocks[pos] = (palette[int(block['state'])]['Name'], block.get('nbt') or {})

    parts = {}
    if storyboard.get('parts'):
        parts = json.loads((schematic_dir / storyboard['parts']).read_text())['parts']

    beats = {b['id'] for b in json.loads((here / storyboard['beats']).read_text())['beats']}

    for cue in storyboard['cues']:
        kind = cue['type']
        where = f"{cue.get('beat', 'abs')} {kind}"

        if 'beat' in cue and cue['beat'] not in beats:
            fail(f'{where}: no beat named "{cue["beat"]}"')

        if kind == 'place':
            spec = cue['blocks']
            for name in ([spec['part']] if isinstance(spec, dict) and 'part' in spec else []):
                if name not in parts:
                    fail(f'{where}: no part named "{name}" — have {sorted(parts)}')

        elif kind == 'showFilter':
            pos = tuple(cue['pos'])
            if pos not in blocks:
                fail(f'{where} {pos}: nothing in the schematic there')
            elif 'Filter' not in blocks[pos][1]:
                fail(f'{where} {pos}: {blocks[pos][0]} has no Filter')
            elif not blocks[pos][1]['Filter']:
                fail(f'{where} {pos}: {blocks[pos][0]} has an empty filter slot — nothing to show')

        elif kind in ('fill', 'screen'):
            if cue.get('action') == 'close':
                continue
            pos = tuple(cue['pos'])
            if pos in blocks:
                name = blocks[pos][0]
                if name not in CONTAINERS:
                    fail(f'{where} {pos}: {name} is not a container')
            elif kind == 'fill':
                fail(f'{where} {pos}: nothing in the schematic there')

        elif kind == 'setBlocks':
            for spec in cue['blocks']:
                pos = tuple(spec['pos'])
                if pos not in blocks:
                    continue
                # Setting the same block again is a state change, not a collision — throwing a
                # lever the build just placed is exactly what the closing beat is for. Putting a
                # *different* block where the build puts one is the mistake worth catching.
                wanted = spec['block'].split('[')[0].split('{')[0]
                if wanted != blocks[pos][0]:
                    fail(f'{where} {pos}: the schematic has {blocks[pos][0]} there and the cue '
                         f'places {wanted} — the build and the cue would fight over it')

    used = set()
    for cue in storyboard['cues']:
        if cue['type'] == 'place' and isinstance(cue['blocks'], dict) and 'part' in cue['blocks']:
            used.add(cue['blocks']['part'])
    for name in sorted(set(parts) - used):
        fail(f'part "{name}" ({len(parts[name])} blocks) is never placed by any cue')

    print(f'{path}: {len(storyboard["cues"])} cues, {len(blocks)} schematic blocks, '
          f'{len(parts)} parts')
    if problems:
        print(f'\n{len(problems)} problems:')
        for message in problems:
            print(f'  {message}')
        return 1
    print('ok')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
