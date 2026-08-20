"""Resolves a parts manifest against a schematic, and says what it missed.

    python3 tools/parts.py schematics/ore_plant.nbt schematics/ore_plant.parts.json
    python3 tools/parts.py … --map          # a plan view, one letter per part

A tutorial builds a machine one assembly at a time — the drive, then the crusher, then the
washing — and the director needs to know which schematic blocks each of those is. Indices would
work and would be unreadable; a rule ("every chain drive, every gearbox, every shaft") stays true
when the schematic is re-cut.

The rules are the manifest, not this file. What this adds is the check: every block belongs to
exactly one part. A block no rule claims would silently never be built, and a block two rules
claim would be built twice by two different beats — neither shows up in a take log, and both are
the kind of thing you find by watching the finished video.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import nbtio  # noqa: E402


def load_blocks(path):
    root = nbtio.load(path)
    palette = root['palette']
    blocks = []
    for index, block in enumerate(root['blocks']):
        entry = palette[int(block['state'])]
        blocks.append({
            'index': index,
            'pos': tuple(int(c) for c in block['pos']),
            'name': entry['Name'],
            'properties': dict(entry.get('Properties', {})),
        })
    return root, blocks


def in_box(pos, box):
    (x0, y0, z0), (x1, y1, z1) = box
    return (min(x0, x1) <= pos[0] <= max(x0, x1)
            and min(y0, y1) <= pos[1] <= max(y0, y1)
            and min(z0, z1) <= pos[2] <= max(z0, z1))


def rule_matches(rule, block):
    """A rule is an AND of the constraints it names; an absent constraint is not a constraint."""
    if 'ids' in rule and block['name'] not in rule['ids']:
        return False
    if 'box' in rule and not in_box(block['pos'], rule['box']):
        return False
    if 'pos' in rule and list(block['pos']) != list(rule['pos']):
        return False
    if 'notIds' in rule and block['name'] in rule['notIds']:
        return False
    return True


def resolve(blocks, manifest):
    """Assign every block to the first part that claims it, and note who else wanted it.

    First-match-wins rather than an error on overlap, because the useful way to write these rules
    is broad-then-specific: "the drive is every shaft anywhere" reads better than the same
    statement with five exceptions carved out of it. The contested list keeps that honest — an
    overlap is a fact about the manifest, and worth seeing, but not a failure.
    """
    owner = {}
    contested = []
    for part in manifest['parts']:
        for block in blocks:
            if not any(rule_matches(rule, block) for rule in part['match']):
                continue
            if block['index'] in owner:
                contested.append((block, owner[block['index']], part['name']))
            else:
                owner[block['index']] = part['name']

    groups = {part['name']: [] for part in manifest['parts']}
    for index, name in sorted(owner.items()):
        groups[name].append(index)
    unclaimed = [b for b in blocks if b['index'] not in owner]
    return groups, unclaimed, contested


def bbox(blocks, indices):
    positions = [blocks[i]['pos'] for i in indices]
    lo = tuple(min(p[i] for p in positions) for i in range(3))
    hi = tuple(max(p[i] for p in positions) for i in range(3))
    return lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('schematic')
    ap.add_argument('manifest')
    ap.add_argument('--map', action='store_true', help='plan view, one letter per part')
    ap.add_argument('--json', help='write the resolved parts here, for the director to read')
    args = ap.parse_args()

    root, blocks = load_blocks(args.schematic)
    manifest = json.loads(Path(args.manifest).read_text())
    groups, unclaimed, contested = resolve(blocks, manifest)

    size = [int(s) for s in root['size']]
    print(f'{args.schematic}: {len(blocks)} blocks, {size[0]}x{size[1]}x{size[2]}')
    print(f'{args.manifest}: {len(manifest["parts"])} parts\n')

    for part in manifest['parts']:
        indices = groups[part['name']]
        if not indices:
            print(f'  {part["name"]:12s}     0  !! claims nothing')
            continue
        lo, hi = bbox(blocks, indices)
        kinds = Counter(blocks[i]['name'] for i in indices)
        top = ', '.join(f'{k[k.find(":") + 1:]}:{v}' for k, v in kinds.most_common(5))
        print(f'  {part["name"]:12s} {len(indices):5d}  '
              f'{hi[0] - lo[0] + 1}x{hi[1] - lo[1] + 1}x{hi[2] - lo[2] + 1} at {lo}')
        print(f'  {"":12s}       {top}')

    if contested:
        print(f'\n{len(contested)} blocks claimed by more than one part (first wins):')
        for block, first, second in contested[:12]:
            print(f'  {str(block["pos"]):14s} {block["name"]:34s} {first} < {second}')

    if unclaimed:
        print(f'\n!! {len(unclaimed)} blocks belong to no part — they would never be built:')
        for name, count in Counter(b['name'] for b in unclaimed).most_common():
            examples = [b['pos'] for b in unclaimed if b['name'] == name][:4]
            print(f'  {count:5d}  {name:36s} {examples}')

    if args.map:
        letters = {part['name']: part.get('letter', part['name'][0].upper())
                   for part in manifest['parts']}
        owner = {}
        for name, indices in groups.items():
            for i in indices:
                owner[blocks[i]['pos']] = letters[name]
        print('\nplan view (topmost block wins)')
        print('    ' + ''.join(str(x % 10) for x in range(size[0])))
        for z in range(size[2]):
            row = ''
            for x in range(size[0]):
                ch = ' '
                for y in range(size[1] - 1, -1, -1):
                    if (x, y, z) in owner:
                        ch = owner[(x, y, z)]
                        break
                row += ch
            print(f'{z:3d} {row}')

    if args.json:
        # Positions, not indices. An index only means anything for one particular cut of the
        # schematic, and this one has already been re-cut as the box moved; a position that no
        # longer exists makes the director refuse the take, while a stale index quietly addresses
        # a different block and nothing complains until somebody watches the video.
        resolved = {
            '_what': f'Generated by tools/parts.py from {args.manifest}. Do not edit — '
                     f'edit the manifest and run it again.',
            'schematic': Path(args.schematic).name,
            'blocks': len(blocks),
            'parts': {name: [list(blocks[i]['pos']) for i in indices]
                      for name, indices in groups.items()},
        }
        Path(args.json).write_text(json.dumps(resolved, indent=1) + '\n')
        print(f'\n-> {args.json}')

    return 1 if unclaimed else 0


if __name__ == '__main__':
    sys.exit(main())
