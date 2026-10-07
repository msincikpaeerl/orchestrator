import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS } from './operations.js';

// Writes github-rest.json: the documented answers of the REST endpoints the fake GitHub serves,
// taken from GitHub's published OpenAPI description of REST API version 2026-03-10 (the version
// the server pins in src/github/client.ts), at a pinned commit of
// https://github.com/github/rest-api-description (ADR 0035). Only the parts a shape needs are
// kept: types, `nullable`, `required`, properties, items, enums and the schemas they reference.
//
// Run by a developer when the pinned version or commit changes, never by the tests:
//   pnpm --filter server exec tsx test/fake-github/documented/extract.ts [<local copy>]
// Without a local copy it downloads the description (about 13 MB).

const COMMIT = '734bc9c1030b774eb3fc909cce477aceea21cf77';
const VERSION = '2026-03-10';
const SOURCE = `https://raw.githubusercontent.com/github/rest-api-description/${COMMIT}/descriptions/api.github.com/api.github.com.${VERSION}.json`;

const KEPT = [
  'type',
  'nullable',
  'required',
  'properties',
  'items',
  'enum',
  'allOf',
  'anyOf',
  'oneOf',
  'additionalProperties',
  'format',
  '$ref',
];

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const local = process.argv[2];
  const text = local ? await readFile(local, 'utf8') : await (await fetch(SOURCE)).text();
  const api = JSON.parse(text) as { paths: Node; components: Node };
  const schemas = (api.components.schemas ?? {}) as Node;
  const responses = (api.components.responses ?? {}) as Node;
  const used = new Map<string, unknown>();

  /** The schema with only the kept keys; each referenced schema is added to `used`. */
  const trim = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(trim);
    if (!isNode(value)) return value;
    const result: Node = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!KEPT.includes(key)) continue;
      if (key === 'properties' && isNode(inner)) {
        result.properties = Object.fromEntries(
          Object.entries(inner).map(([name, property]) => [name, trim(property)]),
        );
      } else if (key === '$ref' && typeof inner === 'string') {
        const name = inner.replace('#/components/schemas/', '');
        result.$ref = name;
        if (!used.has(name)) {
          used.set(name, null);
          used.set(name, trim(schemas[name]));
        }
      } else if (key === 'additionalProperties' && typeof inner === 'boolean') {
        result.additionalProperties = inner;
      } else {
        result[key] = trim(inner);
      }
    }
    return result;
  };

  const operations: Node = {};
  for (const [operation, status] of OPERATIONS) {
    const [method = '', path = ''] = operation.split(' ');
    const item = (api.paths[path] as Node | undefined)?.[method.toLowerCase()] as Node | undefined;
    let response = (item?.responses as Node | undefined)?.[status] as Node | undefined;
    if (typeof response?.$ref === 'string') {
      response = responses[response.$ref.replace('#/components/responses/', '')] as Node;
    }
    const content = response?.content as Node | undefined;
    const schema = (content?.['application/json'] as Node | undefined)?.schema;
    if (schema === undefined) throw new Error(`${operation} ${status}: no documented JSON body`);
    operations[`${operation} ${status}`] = trim(schema);
  }
  const out = {
    source: SOURCE,
    version: VERSION,
    operations,
    schemas: Object.fromEntries([...used.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(import.meta.dirname, 'github-rest.json'), `${JSON.stringify(out)}\n`);
}

await main();
