"""Reading and writing NBT, with the tag types kept intact.

Grown out of the small reader that `schematic_edit.py` used to carry. That one decoded every
integer to a plain Python `int` and every float to a `float`, which is fine when the only thing
you do is add and remove blocks — but not when you copy a block entity out of a live world and
write it back. A Create filter is a nested item compound whose `count` is a TAG_Int and whose
`Slot` is a TAG_Byte, and a byte that comes back as an int is not the same NBT: the game either
rejects it or reads a different value out of it. So every scalar is wrapped in a marker class
that remembers which tag it came from, and a round-trip is byte-for-byte.

Strings stay plain `str` and compounds stay plain `dict`, because those have exactly one tag
each and wrapping them would only make the call sites noisier.

    root = nbtio.load('schematics/ore_plant.nbt')
    root['blocks'].append({'pos': [Int(1), Int(2), Int(3)], 'state': Int(0)})
    nbtio.save(root, 'out.nbt')
"""

import gzip
import struct

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE = 0, 1, 2, 3, 4, 5, 6
TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 7, 8, 9, 10, 11, 12


class Byte(int):
    """TAG_Byte."""


class Short(int):
    """TAG_Short."""


class Int(int):
    """TAG_Int. Also the default for a plain Python int, which is why most call sites can ignore
    all of these classes and still write a correct structure file."""


class Long(int):
    """TAG_Long."""


class Float(float):
    """TAG_Float."""


class Double(float):
    """TAG_Double. Also the default for a plain Python float."""


class ByteArray(bytes):
    """TAG_Byte_Array."""


class IntArray(list):
    """TAG_Int_Array. A list, not a bytes-like: entries are signed 32-bit."""


class LongArray(list):
    """TAG_Long_Array — chunk block state data and entity UUIDs both arrive as one of these."""


class List(list):
    """TAG_List, remembering its element type.

    NBT lists are homogeneous and carry their element tag in the stream, so an empty list still
    says what it would have held. Losing that turns an empty `Items` list of compounds into a
    list of TAG_End, which is legal NBT but no longer the same file.
    """

    def __init__(self, values=(), item_tag=TAG_END):
        super().__init__(values)
        self.item_tag = item_tag


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
            return Byte(self.num('>b', 1))
        if tag == TAG_SHORT:
            return Short(self.num('>h', 2))
        if tag == TAG_INT:
            return Int(self.num('>i', 4))
        if tag == TAG_LONG:
            return Long(self.num('>q', 8))
        if tag == TAG_FLOAT:
            return Float(self.num('>f', 4))
        if tag == TAG_DOUBLE:
            return Double(self.num('>d', 8))
        if tag == TAG_BYTE_ARRAY:
            return ByteArray(self.take(self.num('>i', 4)))
        if tag == TAG_STRING:
            return self.string()
        if tag == TAG_LIST:
            item = self.u1()
            n = self.num('>i', 4)
            # An empty list is written with element type TAG_End; there is nothing to read, but
            # the element type is still worth keeping.
            values = [] if item == TAG_END else [self.payload(item) for _ in range(n)]
            return List(values, item)
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
            return IntArray(Int(self.num('>i', 4)) for _ in range(self.num('>i', 4)))
        if tag == TAG_LONG_ARRAY:
            return LongArray(Long(self.num('>q', 8)) for _ in range(self.num('>i', 4)))
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
        # Marker classes first, and each before its base class: Byte is an int, IntArray is a
        # list, and isinstance would happily agree with the wrong branch.
        if isinstance(v, Byte):
            return TAG_BYTE
        if isinstance(v, Short):
            return TAG_SHORT
        if isinstance(v, Int):
            return TAG_INT
        if isinstance(v, Long):
            return TAG_LONG
        if isinstance(v, Float):
            return TAG_FLOAT
        if isinstance(v, Double):
            return TAG_DOUBLE
        if isinstance(v, ByteArray):
            return TAG_BYTE_ARRAY
        if isinstance(v, IntArray):
            return TAG_INT_ARRAY
        if isinstance(v, LongArray):
            return TAG_LONG_ARRAY
        if isinstance(v, List):
            return TAG_LIST
        if isinstance(v, str):
            return TAG_STRING
        if isinstance(v, dict):
            return TAG_COMPOUND
        if isinstance(v, list):
            return TAG_LIST
        if isinstance(v, (bytes, bytearray)):
            return TAG_BYTE_ARRAY
        # Plain Python numbers: int is the one a hand-written edit produces, and TAG_Int is what
        # a structure file wants for positions and palette indices.
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
        elif tag == TAG_INT_ARRAY:
            self.num('>i', len(v))
            for e in v:
                self.num('>i', e)
        elif tag == TAG_LONG_ARRAY:
            self.num('>i', len(v))
            for e in v:
                self.num('>q', e)
        elif tag == TAG_LIST:
            item = getattr(v, 'item_tag', TAG_END)
            if not v:
                # Keep the declared element type of an empty list if we know it.
                self.u1(item)
                self.num('>i', 0)
                return
            if item == TAG_END:
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


def parse(raw):
    """Decode an uncompressed NBT document, returning the root compound."""
    r = Reader(raw)
    tag = r.u1()
    r.string()  # root name, always empty for structure files
    return r.payload(tag)


def dump(root):
    """Encode a root compound to uncompressed NBT bytes."""
    w = Writer()
    w.u1(TAG_COMPOUND)
    w.string('')
    w.payload(TAG_COMPOUND, root)
    return bytes(w.b)


def load(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return parse(raw)


def save(root, path):
    with gzip.open(path, 'wb') as f:
        f.write(dump(root))
