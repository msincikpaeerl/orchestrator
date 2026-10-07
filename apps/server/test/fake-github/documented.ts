import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATIONS } from './documented/operations.js';

// GitHub's documented answers (documented/github-rest.json, extracted from GitHub's OpenAPI
// description by documented/extract.ts; ADR 0035). The fake GitHub writes only the values it
// models and `shaped` completes them to the documented shape: every required field present, a
// nullable one it does not model is null, an optional one is left out. Then `shapeProblems`
// checks the result, and a field GitHub does not document is refused, so the fake never answers
// a field GitHub removed (as `merge_commit_sha` in version 2026-03-10) or misses one it requires.
// A layer written against the fake therefore reads what GitHub documents, not what the fake
// happened to send (lot 3, the owner's first smoke run).

interface Schema {
  type?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
  format?: string;
  $ref?: string;
}

const documented = JSON.parse(
  readFileSync(join(import.meta.dirname, 'documented', 'github-rest.json'), 'utf8'),
) as { operations: Record<string, Schema>; schemas: Record<string, Schema> };

/** The documented body of `operation` (`POST /repos/{owner}/{repo}/pulls`) answering `status`. */
export function documentedBody(operation: string, status: number): Schema {
  const schema = documented.operations[`${operation} ${String(status)}`];
  if (!schema) throw new Error(`${operation} ${String(status)} is not in github-rest.json`);
  return schema;
}

/** A path template of GitHub's documentation as a pattern; `{ref}`, `{path}`, `{tree_sha}` may hold `/`. */
function templatePattern(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((segment) =>
      /^\{(ref|path|tree_sha)\}$/.test(segment)
        ? '.+'
        : /^\{\w+\}$/.test(segment)
          ? '[^/]+'
          : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

const operations = OPERATIONS.map(([operation, status]) => {
  const [method = '', template = ''] = operation.split(' ');
  return { operation, method, status: Number(status), pattern: templatePattern(template) };
});

/**
 * The documented operation (`GET /repos/{owner}/{repo}/pulls`) of a request's method and path
 * (without the query) answering `status`; undefined when it is not in the extract.
 */
export function documentedOperation(
  method: string,
  path: string,
  status: number,
): string | undefined {
  return operations.find(
    (each) => each.method === method && each.status === status && each.pattern.test(path),
  )?.operation;
}

/** The schema itself: references followed, `allOf` merged into one object. */
function resolve(schema: Schema): Schema {
  let current = schema;
  while (current.$ref !== undefined) {
    const target = documented.schemas[current.$ref];
    if (!target) throw new Error(`no schema ${current.$ref} in github-rest.json`);
    current = { ...target, nullable: current.nullable ?? target.nullable };
  }
  if (current.allOf) {
    const parts = current.allOf.map(resolve);
    return {
      type: 'object',
      nullable: current.nullable ?? parts.some((part) => part.nullable),
      required: parts.flatMap((part) => part.required ?? []),
      properties: Object.assign({}, ...parts.map((part) => part.properties ?? {})) as Record<
        string,
        Schema
      >,
    };
  }
  return current;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * What does not fit the documented schema: missing required fields, wrong types, null where it
 * is not nullable, and fields GitHub does not document. Empty when the value fits.
 */
export function shapeProblems(schema: Schema, value: unknown, path = ''): string[] {
  const at = path || '(the body)';
  const options = schema.oneOf ?? schema.anyOf;
  const resolved = resolve(schema);
  if (options && !schema.$ref) {
    const all = options.map((option) => shapeProblems(option, value, path));
    if (value === null && schema.nullable) return [];
    return all.some((problems) => problems.length === 0)
      ? []
      : (all.sort((a, b) => a.length - b.length)[0] ?? []);
  }
  if (resolved.oneOf ?? resolved.anyOf) return shapeProblems(resolved, value, path);
  if (value === null) return resolved.nullable ? [] : [`${at}: null, not documented as nullable`];
  if (value === undefined) return [`${at}: missing`];
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  const actual = typeOf(value);
  if (type === 'object') {
    if (!isObject(value)) return [`${at}: ${actual}, documented as object`];
    const problems: string[] = [];
    const properties = resolved.properties ?? {};
    for (const name of resolved.required ?? []) {
      if (!(name in value)) problems.push(`${path ? `${path}.` : ''}${name}: missing`);
    }
    const free = resolved.properties === undefined || resolved.additionalProperties !== undefined;
    for (const [name, inner] of Object.entries(value)) {
      const property = properties[name];
      const innerPath = `${path ? `${path}.` : ''}${name}`;
      if (property) problems.push(...shapeProblems(property, inner, innerPath));
      else if (!free) problems.push(`${innerPath}: not documented`);
    }
    return problems;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${at}: ${actual}, documented as array`];
    return value.flatMap((item, index) =>
      resolved.items ? shapeProblems(resolved.items, item, `${path}[${String(index)}]`) : [],
    );
  }
  if (type === 'integer' && actual !== 'integer')
    return [`${at}: ${actual}, documented as integer`];
  if (type === 'number' && actual !== 'integer' && actual !== 'number') {
    return [`${at}: ${actual}, documented as number`];
  }
  if ((type === 'string' || type === 'boolean') && actual !== type) {
    return [`${at}: ${actual}, documented as ${type}`];
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    return [`${at}: a value not among the documented ones`];
  }
  return [];
}

/**
 * How a value nobody gave is made. `fake`: null when nullable, else the type's plainest value,
 * with no optional field and empty lists (what the fake does not model). `nulls`: the same with
 * one item in each list. `inner`: nullable objects and lists filled too (nullable plain values
 * stay null), and optional fields present, to a few levels deep.
 */
type Filling = 'fake' | 'nulls' | 'inner';

/** A value of the schema nobody gave. */
function filler(schema: Schema, filling: Filling = 'fake', depth = 0): unknown {
  const options = schema.oneOf ?? schema.anyOf;
  if (options && !schema.$ref) {
    return schema.nullable && filling !== 'inner' ? null : filler(options[0] ?? {}, filling, depth);
  }
  const resolved = resolve(schema);
  if (resolved.oneOf ?? resolved.anyOf) return filler(resolved, filling, depth);
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  const container = type === 'object' || type === 'array';
  if (resolved.nullable && (filling !== 'inner' || !container || depth > 4)) return null;
  if (resolved.enum) return resolved.enum[0];
  switch (type) {
    case 'object': {
      const properties = resolved.properties ?? {};
      const names =
        filling === 'inner' && depth < 3 ? Object.keys(properties) : (resolved.required ?? []);
      return Object.fromEntries(
        names.map((name) => [name, filler(properties[name] ?? {}, filling, depth + 1)]),
      );
    }
    case 'array':
      return filling === 'fake' || !resolved.items
        ? []
        : [filler(resolved.items, filling, depth + 1)];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'string':
      if (resolved.format === 'date-time') return '2020-01-01T00:00:00Z';
      // Not empty in a documented body: a hash or a name is used in the next request's path.
      return filling === 'fake' ? '' : 'documented';
    default:
      return {};
  }
}

/** `value` completed to the schema: its required fields added where `value` lacks them. */
function fill(schema: Schema, value: unknown): unknown {
  if (value === undefined) return filler(schema);
  const options = schema.oneOf ?? schema.anyOf;
  if (options && !schema.$ref) {
    if (value === null) return null;
    const tries = options.map((option) => fill(option, value));
    return (
      tries.find((tried, index) => shapeProblems(options[index] ?? {}, tried).length === 0) ??
      tries[0]
    );
  }
  const resolved = resolve(schema);
  if (resolved.oneOf ?? resolved.anyOf) return fill(resolved, value);
  if (Array.isArray(value) && resolved.items) {
    const items = resolved.items;
    return value.map((item) => fill(items, item));
  }
  if (!isObject(value) || resolved.properties === undefined) return value;
  const properties = resolved.properties;
  const result: Json = {};
  for (const name of resolved.required ?? []) {
    result[name] = fill(properties[name] ?? {}, value[name]);
  }
  for (const [name, inner] of Object.entries(value)) {
    if (!(name in result)) result[name] = properties[name] ? fill(properties[name], inner) : inner;
  }
  return result;
}

/**
 * The fake's answer to `operation` with `status`: `values` completed to GitHub's documented
 * shape. Throws when the result does not fit it (a fault of the fake, shown in the test's output
 * as an HTTP 500 of the fake).
 */
export function shaped(operation: string, status: number, values: unknown): unknown {
  const schema = documentedBody(operation, status);
  const body = fill(schema, values);
  const problems = shapeProblems(schema, body);
  if (problems.length > 0) {
    throw new Error(
      `the fake's answer to ${operation} (${String(status)}) is not GitHub's documented shape: ${problems.join('; ')}`,
    );
  }
  return body;
}

/**
 * A body GitHub documents for `operation` with every allowed absence: `nulls` has the required
 * fields only, every nullable one null, one item in each list; `inner` fills the nullable objects
 * and lists and adds the optional fields, nullable plain values staying null. What a reader of
 * GitHub's answers must accept.
 */
export function plainestBody(
  operation: string,
  status: number,
  filling: 'nulls' | 'inner',
): unknown {
  return filler(documentedBody(operation, status), filling);
}
