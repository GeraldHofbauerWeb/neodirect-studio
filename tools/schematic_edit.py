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

import gzip
import json
import struct
import sys

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE = 0, 1, 2, 3, 4, 5, 6
TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 7, 8, 9, 10, 11, 12


class Int(int):
    """Marks a value that must round-trip as TAG_Int rather than being guessed from its Python type."""


class Reader:
    def __init__(self, data):
        self.d, self.i = data, 0

    def u1(self):
        v = self.d[self.i]
        self.i += 1
        return v

    def take(self, n):
        v = self.d[self.i:self.i + n]
        self.i += n
        return v

    def num(self, fmt, size):
        v = struct.unpack_from(fmt, self.d, self.i)[0]
        self.i += size
        return v

    def string(self):
        return self.take(self.num('>H', 2)).decode('utf-8', 'replace')

    def payload(self, tag):
        if tag == TAG_BYTE:
            return self.num('>b', 1)
        if tag == TAG_SHORT:
            return self.num('>h', 2)
        if tag == TAG_INT:
            return Int(self.num('>i', 4))
        if tag == TAG_LONG:
            return self.num('>q', 8)
        if tag == TAG_FLOAT:
            return self.num('>f', 4)
        if tag == TAG_DOUBLE:
            return self.num('>d', 8)
        if tag == TAG_BYTE_ARRAY:
            return self.take(self.num('>i', 4))
        if tag == TAG_STRING:
            return self.string()
        if tag == TAG_LIST:
            item = self.u1()
            n = self.num('>i', 4)
            # An empty list is written with element type TAG_End; there is nothing to read.
            return [] if item == TAG_END else [self.payload(item) for _ in range(n)]
        if tag == TAG_COMPOUND:
            out = {}
            while True:
                t = self.u1()
                if t == TAG_END:
                    return out
                # Name first, on its own line: `d[self.string()] = self.payload(t)` would read the
                # payload before the name, because Python evaluates the right-hand side first.
                key = self.string()
                out[key] = self.payload(t)
        if tag == TAG_INT_ARRAY:
            return [Int(self.num('>i', 4)) for _ in range(self.num('>i', 4))]
        if tag == TAG_LONG_ARRAY:
            return [self.num('>q', 8) for _ in range(self.num('>i', 4))]
        raise ValueError(f'unknown tag {tag}')


class Writer:
    def __init__(self):
        self.b = bytearray()

    def u1(self, v):
        self.b.append(v)

    def num(self, fmt, v):
        self.b.extend(struct.pack(fmt, v))

    def string(self, s):
        raw = s.encode('utf-8')
        self.num('>H', len(raw))
        self.b.extend(raw)

    def tag_of(self, v):
        if isinstance(v, Int):
            return TAG_INT
        if isinstance(v, str):
            return TAG_STRING
        if isinstance(v, dict):
            return TAG_COMPOUND
        if isinstance(v, list):
            return TAG_LIST
        if isinstance(v, (bytes, bytearray)):
            return TAG_BYTE_ARRAY
        if isinstance(v, int):
            return TAG_INT
        if isinstance(v, float):
            return TAG_DOUBLE
        raise TypeError(f'cannot write {type(v)}')

    def payload(self, tag, v):
        if tag == TAG_BYTE:
            self.num('>b', v)
        elif tag == TAG_SHORT:
            self.num('>h', v)
        elif tag == TAG_INT:
            self.num('>i', v)
        elif tag == TAG_LONG:
            self.num('>q', v)
        elif tag == TAG_FLOAT:
            self.num('>f', v)
        elif tag == TAG_DOUBLE:
            self.num('>d', v)
        elif tag == TAG_STRING:
            self.string(v)
        elif tag == TAG_BYTE_ARRAY:
            self.num('>i', len(v))
            self.b.extend(v)
        elif tag == TAG_LIST:
            if not v:
                self.u1(TAG_END)
                self.num('>i', 0)
                return
            item = self.tag_of(v[0])
            self.u1(item)
            self.num('>i', len(v))
            for e in v:
                self.payload(item, e)
        elif tag == TAG_COMPOUND:
            for k, val in v.items():
                t = self.tag_of(val)
                self.u1(t)
                self.string(k)
                self.payload(t, val)
            self.u1(TAG_END)
        else:
            raise TypeError(f'cannot write tag {tag}')


def load(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    r = Reader(raw)
    tag = r.u1()
    r.string()  # root name, always empty for structure files
    return r.payload(tag)


def save(root, path):
    w = Writer()
    w.u1(TAG_COMPOUND)
    w.string('')
    w.payload(TAG_COMPOUND, root)
    with gzip.open(path, 'wb') as f:
        f.write(bytes(w.b))


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
