"""Applies a recorded list of edits to an exported Create schematic.

The schematic in this repo is not Gerry's export — it is his export plus a couple of deliberate
changes. That is a dangerous kind of file to keep around unlabelled, so the edits live in
`schematics/edits.json` and this script replays them from the original every time. The export in
the modpack instance is only ever read.

    python3 tools/schematic_edit.py \\
        ~/.minecraft-instances/sebsmodpack4/schematics/mining_drill_1.nbt \\
        schematics/edits.json \\
        schematics/mining_drill_1.nbt

Create writes plain vanilla structure NBT, so this is a small hand-rolled NBT reader/writer
rather than anything Minecraft-specific.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The NBT reader and writer live in nbtio, because world_clip.py needs the same one and needs
# it to keep tag types intact. Int is re-exported: an edit's positions and palette indices are
# plain Python ints and have to be written as TAG_Int.
from nbtio import Int, load, save  # noqa: E402


def palette_index(root, name, properties):
    """Index of a block state in the palette, appending one if it is not there yet."""
    palette = root['palette']
    for i, entry in enumerate(palette):
        if entry.get('Name') == name and entry.get('Properties', {}) == properties:
            return i
    palette.append({'Name': name, 'Properties': dict(properties)} if properties else {'Name': name})
    return len(palette) - 1


def op_add(root, edit):
    pos = [Int(c) for c in edit['pos']]
    if any(tuple(int(c) for c in b['pos']) == tuple(edit['pos']) for b in root['blocks']):
        raise SystemExit(f"add: {edit['pos']} is already occupied")
    index = palette_index(root, edit['block'], edit.get('properties', {}))
    root['blocks'].append({'pos': pos, 'state': Int(index)})
    return f"added {edit['block']} at {edit['pos']}"


def op_remove(root, edit):
    target = tuple(edit['pos'])
    before = len(root['blocks'])
    root['blocks'] = [b for b in root['blocks'] if tuple(int(c) for c in b['pos']) != target]
    removed = before - len(root['blocks'])
    if removed == 0:
        raise SystemExit(f"remove: nothing at {edit['pos']}")
    # The palette entry is deliberately left in place: entries are addressed by index, so dropping
    # one would silently renumber every block after it.
    return f"removed {removed} block(s) at {edit['pos']}"


OPS = {'add': op_add, 'remove': op_remove}


def main(source, edits_path, dest):
    root = load(source)
    edits = json.load(open(edits_path))

    print(f"{source}\n  {len(root['blocks'])} blocks, {len(root['palette'])} palette entries")
    for edit in edits['edits']:
        op = OPS.get(edit['op'])
        if op is None:
            raise SystemExit(f"unknown op: {edit['op']}")
        print(f"  {op(root, edit)}   — {edit.get('why', '')}")

    save(root, dest)
    print(f"{dest}\n  {len(root['blocks'])} blocks, {len(root['palette'])} palette entries")


if __name__ == '__main__':
    main(*sys.argv[1:4])
