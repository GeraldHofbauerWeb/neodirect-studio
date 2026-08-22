/**
 * JSON that remembers where it came from.
 *
 * The documents in this repository are half data and half prose: every one of them carries `_what`
 * keys explaining why a number is what it is, and the order of the keys is part of how they read.
 * A round trip through `JSON.parse` and `JSON.stringify` keeps the data and throws all of that
 * away — the comments survive as keys, but the line breaks, the spacing and any hand formatting do
 * not, and a one-field change arrives as a diff touching every line.
 *
 * So editing here is surgical. The parser records where every value starts and ends in the source
 * text; a change splices new text over exactly that range and leaves every other byte alone. What
 * comes out of a no-op edit is the input, byte for byte.
 *
 * Only new documents are serialised whole, and they are serialised the way everything else in the
 * repository already is: `JSON.stringify(value, null, 2)`. That is not a preference, it is what
 * tools/mk-build-take.mjs and tools/make-timeline.mjs write, and a second house style would show
 * up as noise in every generated diff.
 */

/** A parsed value, plus where it sits in the source. */
class Node {
  constructor(kind, start, end, value) {
    this.kind = kind;
    this.start = start;
    this.end = end;
    this.value = value;
    /** For objects: `[{key, keyStart, keyEnd, node, start, end}]`, in source order. */
    this.members = null;
    /** For arrays: the item nodes, in source order. */
    this.items = null;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * Parses JSON into a tree of {@link Node}, each knowing its span in `text`.
 *
 * Deliberately strict and deliberately small: these files are written by `JSON.stringify` and by
 * Python's `json`, so there are no comments, no trailing commas and no NaN to accommodate. A
 * parser that accepted them would only be a parser that could not write them back.
 */
export function parse(text) {
  let i = 0;

  const fail = (message) => {
    const line = text.slice(0, i).split('\n').length;
    const column = i - text.lastIndexOf('\n', i - 1);
    throw new SyntaxError(`${message} at line ${line} column ${column}`);
  };

  const skip = () => {
    while (i < text.length && WHITESPACE.has(text[i])) i++;
  };

  const expect = (ch) => {
    if (text[i] !== ch) fail(`expected ${JSON.stringify(ch)}, found ${JSON.stringify(text[i] ?? '<end>')}`);
    i++;
  };

  const parseString = () => {
    const start = i;
    expect('"');
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        i++;
        return { start, end: i, value: JSON.parse(text.slice(start, i)) };
      }
      i++;
    }
    fail('unterminated string');
    return null;
  };

  const parseValue = () => {
    skip();
    const ch = text[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') {
      const s = parseString();
      return new Node('string', s.start, s.end, s.value);
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      for (const word of ['true', 'false', 'null']) {
        if (text.startsWith(word, i)) {
          const start = i;
          i += word.length;
          return new Node(word === 'null' ? 'null' : 'boolean', start, i, JSON.parse(word));
        }
      }
      fail('unexpected literal');
    }
    const start = i;
    if (text[i] === '-') i++;
    while (i < text.length && /[0-9eE+.\-]/.test(text[i])) i++;
    if (i === start) fail('unexpected character');
    const raw = text.slice(start, i);
    const value = Number(raw);
    if (Number.isNaN(value) && raw !== 'NaN') fail(`bad number ${JSON.stringify(raw)}`);
    return new Node('number', start, i, value);
  };

  const parseObject = () => {
    const start = i;
    expect('{');
    const members = [];
    const value = {};
    skip();
    if (text[i] === '}') {
      i++;
      const node = new Node('object', start, i, value);
      node.members = members;
      return node;
    }
    for (;;) {
      skip();
      const key = parseString();
      skip();
      expect(':');
      const child = parseValue();
      members.push({ key: key.value, keyStart: key.start, keyEnd: key.end, node: child, start: key.start, end: child.end });
      value[key.value] = child.value;
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      expect('}');
      break;
    }
    const node = new Node('object', start, i, value);
    node.members = members;
    return node;
  };

  const parseArray = () => {
    const start = i;
    expect('[');
    const items = [];
    const value = [];
    skip();
    if (text[i] === ']') {
      i++;
      const node = new Node('array', start, i, value);
      node.items = items;
      return node;
    }
    for (;;) {
      const child = parseValue();
      items.push(child);
      value.push(child.value);
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      expect(']');
      break;
    }
    const node = new Node('array', start, i, value);
    node.items = items;
    return node;
  };

  const root = parseValue();
  skip();
  if (i !== text.length) fail('trailing content');
  return root;
}

/** Splits an RFC 6901 pointer into its unescaped segments. `""` is the whole document. */
export function pointerSegments(pointer) {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) throw new Error(`pointer must start with "/": ${pointer}`);
  return pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Builds a pointer out of segments, escaping as RFC 6901 asks. */
export function pointerOf(...segments) {
  return segments.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/**
 * Walks a pointer to the node it names.
 *
 * Returns the node itself plus its parent and the key or index it hangs off, because most edits
 * need the surroundings: replacing a value needs its span, removing one needs the comma beside it,
 * and adding one needs to know where the last sibling ended.
 */
export function locate(root, pointer) {
  const segments = pointerSegments(pointer);
  let node = root;
  let parent = null;
  let step = null;
  let member = null;
  for (const segment of segments) {
    parent = node;
    member = null;
    if (node.kind === 'object') {
      member = node.members.find((m) => m.key === segment);
      if (!member) return { node: null, parent, step: segment, member: null, missing: true };
      node = member.node;
      step = segment;
    } else if (node.kind === 'array') {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.items.length) {
        return { node: null, parent, step: index, member: null, missing: true };
      }
      node = node.items[index];
      step = index;
    } else {
      throw new Error(`pointer ${pointer} descends into a ${node.kind}`);
    }
  }
  return { node, parent, step, member, missing: false };
}

/** The indentation of the line `offset` sits on — what a spliced-in block has to line up with. */
function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : '';
}

/** The indent unit a document uses, read off its first indented line. Two spaces if it has none. */
export function indentUnitOf(text) {
  const match = /\n([ \t]+)\S/.exec(text);
  return match ? match[1] : '  ';
}

/**
 * Serialises a value the way the rest of the repository writes JSON, then re-indents it to sit at
 * `indent` — every line but the first, which is already in place after the key.
 */
export function render(value, indent = '', unit = '  ') {
  const body = JSON.stringify(value, null, unit);
  if (body === undefined) throw new Error('value is not representable as JSON');
  return body.split('\n').map((line, n) => (n === 0 ? line : indent + line)).join('\n');
}

/**
 * Applies edits to `text` and returns the new text.
 *
 * Ops are `{op, pointer, value?, key?, index?}`:
 *
 *   replace  the value at `pointer` becomes `value` — the only bytes that move are its own
 *   set      like replace, but creates the key if the parent object does not have it yet
 *   add      inserts `value` into the array at `pointer`, at `index` or at the end
 *   remove   deletes the member or item at `pointer`, taking its comma with it
 *
 * Each op is applied against a fresh parse. That is one parse per edit rather than one per batch,
 * which for documents this size is nothing, and it means an op can rely on what the op before it
 * did — including creating the parent it wants to write into.
 */
export function applyEdits(text, ops) {
  let out = text;
  for (const op of ops) {
    out = applyEdit(out, op);
  }
  return out;
}

function applyEdit(text, op) {
  const unit = indentUnitOf(text);
  const root = parse(text);
  const { node, parent, step, member, missing } = locate(root, op.pointer ?? '');

  if (op.op === 'replace' || op.op === 'set') {
    if (missing) {
      if (op.op !== 'set') throw new Error(`nothing at ${op.pointer}`);
      return insertMember(text, parent, String(step), op.value, unit);
    }
    const indent = lineIndent(text, member ? member.start : node.start);
    return text.slice(0, node.start) + render(op.value, indent, unit) + text.slice(node.end);
  }

  if (op.op === 'add') {
    if (missing || node.kind !== 'array') throw new Error(`no array at ${op.pointer}`);
    return insertItem(text, node, op.index ?? node.items.length, op.value, unit);
  }

  if (op.op === 'remove') {
    if (missing) throw new Error(`nothing at ${op.pointer}`);
    return removeAt(text, parent, member, node);
  }

  throw new Error(`unknown op ${JSON.stringify(op.op)}`);
}

function insertMember(text, object, key, value, unit) {
  if (object.kind !== 'object') throw new Error('cannot add a key to a non-object');
  const inner = lineIndent(text, object.start) + unit;
  const rendered = `${JSON.stringify(key)}: ${render(value, inner, unit)}`;
  if (object.members.length === 0) {
    return `${text.slice(0, object.start + 1)}\n${inner}${rendered}\n${lineIndent(text, object.start)}${text.slice(object.end - 1)}`;
  }
  const last = object.members[object.members.length - 1];
  return `${text.slice(0, last.end)},\n${inner}${rendered}${text.slice(last.end)}`;
}

function insertItem(text, array, index, value, unit) {
  const inner = lineIndent(text, array.start) + unit;
  if (array.items.length === 0) {
    return `${text.slice(0, array.start + 1)}\n${inner}${render(value, inner, unit)}\n${lineIndent(text, array.start)}${text.slice(array.end - 1)}`;
  }
  const at = Math.max(0, Math.min(index, array.items.length));
  if (at === array.items.length) {
    const last = array.items[array.items.length - 1];
    return `${text.slice(0, last.end)},\n${inner}${render(value, inner, unit)}${text.slice(last.end)}`;
  }
  const next = array.items[at];
  const lineStart = text.lastIndexOf('\n', next.start - 1) + 1;
  return `${text.slice(0, lineStart)}${inner}${render(value, inner, unit)},\n${text.slice(lineStart)}`;
}

/** Cuts a member or item out, along with one comma and the whitespace that only existed for it. */
function removeAt(text, parent, member, node) {
  const start = member ? member.start : node.start;
  const end = member ? member.end : node.end;
  const siblings = parent.kind === 'object' ? parent.members : parent.items;
  const spans = siblings.map((s) => (parent.kind === 'object' ? { start: s.start, end: s.end } : { start: s.start, end: s.end }));
  const at = spans.findIndex((s) => s.start === start);
  let from = start;
  let to = end;
  if (at < spans.length - 1) {
    // Not the last one: take the comma after it and the whitespace up to the next sibling.
    to = spans[at + 1].start;
  } else if (at > 0) {
    // The last one: take the comma before it instead, or the object closes on a stray comma.
    from = spans[at - 1].end;
  } else {
    // The only one: leave an empty container, indentation and all.
    from = parent.start + 1;
    to = parent.end - 1;
    return text.slice(0, from) + text.slice(to);
  }
  // Whatever whitespace preceded the member belonged to it; pull it in so no blank line is left.
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  if (at === spans.length - 1 && text.slice(lineStart, from).trim() === '') from = Math.max(from, spans[at - 1].end);
  return text.slice(0, from) + text.slice(to);
}
