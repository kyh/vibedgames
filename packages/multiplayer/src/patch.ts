/**
 * Shared state travels as path operations: the leaves that changed, not the
 * objects holding them. A host moving one unit of two hundred sends
 * `[["units", "u7", "x"], 312]`, where a whole-key write would resend every
 * unit. The client diffs what the game wrote against its copy of the room's
 * state; the server and every peer apply the same ops, so all copies agree.
 *
 * - `[path, value]` sets the value at `path`, creating missing objects on the
 *   way; `[path]` deletes the key at `path`. `[[], state]` replaces the whole
 *   state.
 * - Objects diff key by key. Arrays diff element by element while their
 *   length holds; any other array change replaces the array, so a collection
 *   that grows and shrinks belongs in an object keyed by id.
 * - Every op repeats the path to its leaf, so when most of a container
 *   changed, one op setting it whole is shorter: the diff sends whichever of
 *   the two is.
 * - Applying copies every object along a changed path and shares the rest:
 *   the root is new whenever anything changed, and an untouched subtree keeps
 *   its identity, so a game can cache what it derives from it by reference.
 *
 * The server runs these functions too (`readPatch`, `applyPatch`), so both
 * ends agree on what an op means.
 */
import type { JsonRecord, JsonValue } from "./types.js";
import { FORBIDDEN_KEYS, findNestingIssue, MAX_STATE_DEPTH } from "./validation.js";

/** A key into an object, or an index into an array. */
export type PatchSegment = string | number;

/** Set the value at a path, or — with no value — delete the key there. */
export type PatchOp = [path: PatchSegment[], value: JsonValue] | [path: PatchSegment[]];

type Container = JsonRecord | JsonValue[];

const isRecord = (value: JsonValue | undefined): value is JsonRecord =>
  value instanceof Object && !Array.isArray(value);

const isString = (value: JsonValue | undefined): value is string => String(value) === value;

/** A whole number from 0: an array index. */
const isIndex = (value: JsonValue | undefined): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** `record[key]` if the record holds it itself: never a prototype's member. */
const own = (record: JsonRecord, key: string): JsonValue | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * A copy of `value` as JSON would carry it: keys holding `undefined` are
 * dropped (and so never diffed as present), and prototype keys skipped.
 */
export const cloneJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item ?? null));
  }
  if (isRecord(value)) {
    const copy: JsonRecord = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== undefined && !FORBIDDEN_KEYS.has(key)) {
        copy[key] = cloneJson(child);
      }
    }
    return copy;
  }
  return value;
};

// The diff walks the whole of what it compares, so it keeps one path and
// pushes and pops segments on it, copying the path only into an op it emits.
const diffValue = (
  prev: JsonValue | undefined,
  next: JsonValue,
  path: PatchSegment[],
  ops: PatchOp[],
): void => {
  if (prev === next) {
    return;
  }
  if (isRecord(prev) && isRecord(next)) {
    diffChildren(prev, next, path, ops);
  } else if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length) {
    diffChildren(prev, next, path, ops);
  } else {
    ops.push([[...path], next]);
  }
};

/**
 * `prev` into `next` child by child, both records or both arrays of one
 * length; then, if that took several ops, one op setting `next` whole instead
 * when it is shorter on the wire.
 */
const diffChildren = (
  prev: Container,
  next: Container,
  path: PatchSegment[],
  ops: PatchOp[],
): void => {
  const start = ops.length;
  if (Array.isArray(prev) && Array.isArray(next)) {
    for (let i = 0; i < next.length; i += 1) {
      path.push(i);
      diffValue(prev[i], next[i] ?? null, path, ops);
      path.pop();
    }
  } else if (isRecord(prev) && isRecord(next)) {
    for (const key of Object.keys(next)) {
      const value = next[key];
      if (value !== undefined) {
        path.push(key);
        diffValue(own(prev, key), value, path, ops);
        path.pop();
      }
    }
    for (const key of Object.keys(prev)) {
      if (prev[key] !== undefined && own(next, key) === undefined) {
        ops.push([[...path, key]]);
      }
    }
  }
  if (ops.length - start < 2) {
    return;
  }
  const partsLength = JSON.stringify(ops.slice(start)).length;
  // Whole, a container takes at least two characters a child: below that,
  // the ops are the shorter, and the container need not be serialized.
  const children = Array.isArray(next) ? next.length : Object.keys(next).length;
  if (partsLength <= 2 * children) {
    return;
  }
  const whole: PatchOp = [[...path], next];
  if (JSON.stringify(whole).length < partsLength) {
    ops.length = start;
    ops.push(whole);
  }
};

/**
 * The ops that turn `prev` into `next`. With `keys`, only those top-level keys
 * are compared — the ones a write named — and a named key `next` lacks is
 * deleted.
 */
export const diffState = (
  prev: JsonRecord,
  next: JsonRecord,
  keys?: Iterable<string>,
): PatchOp[] => {
  const ops: PatchOp[] = [];
  if (keys === undefined) {
    diffChildren(prev, next, [], ops);
    return ops;
  }
  for (const key of keys) {
    const value = own(next, key);
    if (value !== undefined) {
      diffValue(own(prev, key), value, [key], ops);
    } else if (own(prev, key) !== undefined) {
      ops.push([[key]]);
    }
  }
  return ops;
};

/** `value`, copied unless this apply already copied it (`fresh`). */
const writable = <T extends Container>(value: T, fresh: Set<Container>): T => {
  if (fresh.has(value)) {
    return value;
  }
  // SAFETY: a spread of an array is an array and of an object an object, so
  // the copy has the type of what it copies.
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as T;
  fresh.add(copy);
  return copy;
};

/** The child of `container` at `segment`, if the segment fits the container. */
const childAt = (container: Container, segment: PatchSegment): JsonValue | undefined => {
  if (Array.isArray(container)) {
    return isIndex(segment) ? container[segment] : undefined;
  }
  return isString(segment) ? own(container, segment) : undefined;
};

/** One op onto `root`, copying what it writes through; the (possibly new) root. */
const applyOp = (root: JsonRecord, op: PatchOp, fresh: Set<Container>): JsonRecord => {
  const [path] = op;
  const value = op.length === 2 ? op[1] : undefined;
  if (path.length === 0) {
    return isRecord(value) ? value : root;
  }
  if (path.some((segment) => isString(segment) && FORBIDDEN_KEYS.has(segment))) {
    return root;
  }
  const top = writable(root, fresh);
  let container: Container = top;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] ?? "";
    const child = childAt(container, segment);
    let inner: Container;
    if (isRecord(child) || Array.isArray(child)) {
      inner = writable(child, fresh);
    } else if (value !== undefined && isString(segment) && !Array.isArray(container)) {
      // A set through a missing (or scalar) member makes it an object; a
      // delete, or an index, finds nothing to make.
      inner = {};
      fresh.add(inner);
    } else {
      return root;
    }
    if (Array.isArray(container)) {
      container[Number(segment)] = inner;
    } else {
      container[String(segment)] = inner;
    }
    container = inner;
  }
  const last = path.at(-1) ?? "";
  if (Array.isArray(container)) {
    // An array takes element writes within its length: a resize replaces the
    // array, one level up.
    if (value !== undefined && isIndex(last) && last < container.length) {
      container[last] = value;
    }
  } else if (isString(last)) {
    if (value === undefined) {
      // `container` is this apply's own copy, so the key goes from it alone.
      Reflect.deleteProperty(container, last);
    } else {
      container[last] = value;
    }
  }
  return top;
};

/**
 * `state` with `ops` applied, copy-on-write: `state` itself is not modified,
 * every object along a changed path is new and the rest is shared. An op that
 * does not fit the state (an index past an array's end, a path through an
 * array by key) changes nothing.
 */
export const applyPatch = (state: JsonRecord, ops: readonly PatchOp[]): JsonRecord => {
  const fresh = new Set<Container>();
  let root = state;
  for (const op of ops) {
    root = applyOp(root, op, fresh);
  }
  return root;
};

/** `ops` with their values deep-copied: for a copy that must not alias the game's objects. */
export const clonePatch = (ops: readonly PatchOp[]): PatchOp[] =>
  ops.map((op) => (op.length === 2 ? [[...op[0]], cloneJson(op[1])] : [[...op[0]]]));

const isSegment = (segment: JsonValue): segment is PatchSegment =>
  (isString(segment) && !FORBIDDEN_KEYS.has(segment)) || isIndex(segment);

/**
 * `data` as a state patch — or, when it is not one, why. A patch is a list of
 * ops; each op's path is object keys and array indices (no prototype keys),
 * with a value to set or none to delete, and nothing it writes nests deeper
 * than a whole state may (`findStructuralIssue`). The party server reads
 * every `state_patch` through this before applying it, and the client checks
 * its own the same way before sending, so both refuse the same patches.
 */
export const readPatch = (data: JsonValue): PatchOp[] | string => {
  if (!Array.isArray(data)) {
    return "a state patch is a list of ops";
  }
  const ops: PatchOp[] = [];
  for (const op of data) {
    if (!Array.isArray(op) || (op.length !== 1 && op.length !== 2)) {
      return "an op is [path, value] or [path]";
    }
    const [path] = op;
    if (!Array.isArray(path) || !path.every(isSegment)) {
      return "a path is a list of keys and indices";
    }
    // The value's parent sits `path.length` levels down: the state is level 1.
    if (path.length > MAX_STATE_DEPTH) {
      return `nesting exceeds ${MAX_STATE_DEPTH} levels`;
    }
    if (op.length === 1) {
      if (path.length === 0) {
        return "the whole state cannot be deleted";
      }
      ops.push([path]);
      continue;
    }
    const value = op[1] ?? null;
    if (path.length === 0 && !isRecord(value)) {
      return "the whole state must be an object";
    }
    const issue = value instanceof Object ? findNestingIssue(value, path.length + 1) : null;
    if (issue !== null) {
      return issue;
    }
    ops.push([path, value]);
  }
  return ops;
};
