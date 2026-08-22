/**
 * ZIP, written and read here rather than pulled in.
 *
 * A project has to leave the machine as one file — that is what "share it" means — and the file
 * should open by double-clicking on whatever the person receiving it uses. That rules out a bespoke
 * container and points at ZIP, which every desktop already understands.
 *
 * Writing one is a header, the deflated bytes, a central directory and an end record; Node's zlib
 * does the only hard part. So this stays inside the rule the rest of the pipeline keeps: no
 * dependencies outside the studio's own browser bundle.
 *
 * Entries are stored in the order given and stamped with a fixed date by default, so exporting the
 * same project twice produces the same bytes and two exports can be compared.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS time and date, which is what ZIP carries and how it loses your seconds. */
function dosStamp(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

/**
 * Builds a ZIP out of `[{name, data}]`.
 *
 * `data` is a Buffer or a string. Anything that does not get smaller when deflated is stored as it
 * is — which for a schematic's already-gzipped NBT is the usual case, and saves pretending.
 */
export function write(entries, { date = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)) } = {}) {
  const { time, day } = dosStamp(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = raw.length ? deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0);
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(sum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0o644 << 16, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/** Reads a ZIP back into `[{name, data}]`, in the order the central directory lists. */
export function read(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END) end--;
  if (end < 0) throw new Error('not a zip file: no end-of-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error(`zip directory entry ${i} is malformed`);
    const method = buffer.readUInt16LE(at + 10);
    const sum = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localAt + 26);
    const localExtraLength = buffer.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (data.length !== size) throw new Error(`${name}: expected ${size} bytes, unpacked ${data.length}`);
    if (crc32(data) !== sum) throw new Error(`${name}: checksum does not match — the archive is damaged`);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Just the listing, without unpacking anything. */
export function list(buffer) {
  return read(buffer).map(({ name, data }) => ({ name, size: data.length }));
}
