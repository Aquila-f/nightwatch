import { stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type SchemaDocument = {
  file: string;
  root: JsonObject;
};

type ValidationIssue = {
  pointer: string;
  reason: string;
};

type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false };

type SchemaLookup = {
  exists: boolean;
  document: SchemaDocument | null;
};

type CheckStatus = "ok" | "failed" | "skipped";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONTRACTS_ROOT = resolve(import.meta.dir);
const SCHEMAS_ROOT = join(CONTRACTS_ROOT, "schemas");
const EXAMPLES_ROOT = join(CONTRACTS_ROOT, "examples");
const FIXTURES_ROOT = join(CONTRACTS_ROOT, "fixtures");
const DEPLOY_ROOT = CONTRACTS_ROOT;

const JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function displayPath(file: string): string {
  const absolute = resolve(file);
  const projectRelative = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
  return projectRelative && !projectRelative.startsWith("../") ? projectRelative : absolute;
}

function pointerSegment(value: string | number): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, child: string | number): string {
  return `${pointer}/${pointerSegment(child)}`;
}

function printablePointer(pointer: string): string {
  return pointer || "/";
}

function oneLine(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/\s+/g, " ").trim();
}

function lineFromParseError(error: unknown, source: string, baseLine: number): number {
  const message = oneLine(error);
  const lineMatch = message.match(/\bline\s+(\d+)\b/i);
  if (lineMatch) return baseLine + Number(lineMatch[1]);

  const rowMatch = message.match(/\b(?:at|row)\s+(\d+)\b/i);
  if (rowMatch) return baseLine + Number(rowMatch[1]);

  const positionMatch = message.match(/\bposition\s+(\d+)\b/i);
  if (positionMatch) {
    const position = Math.max(0, Number(positionMatch[1]));
    return baseLine + source.slice(0, position).split(/\r?\n/).length;
  }

  const characterMatch = message.match(/\bcharacter\s+(\d+)\b/i);
  if (characterMatch) {
    const position = Math.max(0, Number(characterMatch[1]));
    return baseLine + source.slice(0, position).split(/\r?\n/).length;
  }

  return baseLine + 1;
}

class Reporter {
  private readonly messages: string[] = [];
  private readonly skipped = new Set<string>();

  issue(file: string, pointer: string, reason: string, line?: number): void {
    const lineSuffix = line && line > 0 ? `:${line}` : "";
    this.messages.push(
      `${displayPath(file)}${lineSuffix}: ${printablePointer(pointer)}: ${oneLine(reason)}`,
    );
  }

  skip(file: string): void {
    const path = displayPath(file);
    if (this.skipped.has(path)) return;
    this.skipped.add(path);
    this.messages.push(`skip: ${path}`);
  }

  print(): void {
    for (const message of this.messages) console.log(message);
  }
}

function parseJsonText(
  source: string,
  file: string,
  reporter: Reporter,
  baseLine = 0,
): Parsed<JsonValue> {
  try {
    return { ok: true, value: JSON.parse(source) as JsonValue };
  } catch (error) {
    reporter.issue(file, "", `invalid JSON: ${oneLine(error)}`, lineFromParseError(error, source, baseLine));
    return { ok: false };
  }
}

function schemaAtPointer(root: JsonValue, fragment: string): JsonValue | undefined {
  if (fragment === "" || fragment === "#") return root;
  const pointer = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;

  let current: JsonValue | undefined = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isRecord(current)) {
      if (!hasOwn(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

class SchemaStore {
  private readonly documents = new Map<string, SchemaDocument | null>();

  constructor(private readonly reporter: Reporter) {}

  async load(file: string): Promise<SchemaDocument | null> {
    const absolute = resolve(file);
    if (this.documents.has(absolute)) return this.documents.get(absolute) ?? null;

    if (!(await Bun.file(absolute).exists())) {
      this.documents.set(absolute, null);
      return null;
    }

    let source: string;
    try {
      source = await Bun.file(absolute).text();
    } catch (error) {
      this.reporter.issue(absolute, "", `cannot read schema: ${oneLine(error)}`);
      this.documents.set(absolute, null);
      return null;
    }

    const parsed = parseJsonText(source, absolute, this.reporter);
    if (!parsed.ok) {
      this.documents.set(absolute, null);
      return null;
    }
    if (!isRecord(parsed.value)) {
      this.reporter.issue(absolute, "", "schema root must be an object");
      this.documents.set(absolute, null);
      return null;
    }

    const document: SchemaDocument = { file: absolute, root: parsed.value };
    this.documents.set(absolute, document);
    return document;
  }

  async loadMany(files: string[]): Promise<void> {
    for (const file of files) await this.load(file);
  }

  resolve(ref: string, current: SchemaDocument): { document: SchemaDocument; schema: JsonValue } | null {
    if (ref === "#" || ref.startsWith("#/")) {
      const schema = schemaAtPointer(current.root, ref);
      return schema === undefined ? null : { document: current, schema };
    }

    const hash = ref.indexOf("#");
    const filePart = hash < 0 ? ref : ref.slice(0, hash);
    const fragment = hash < 0 ? "" : ref.slice(hash);
    if (!filePart) return null;

    const targetFile = resolve(dirname(current.file), filePart);
    const document = this.documents.get(targetFile);
    if (!document) return null;
    const schema = schemaAtPointer(document.root, fragment);
    return schema === undefined ? null : { document, schema };
  }
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function validate(
  value: unknown,
  schema: JsonValue,
  document: SchemaDocument,
  store: SchemaStore,
  pointer: string,
  depth: number,
): ValidationIssue[] {
  if (depth > 100) return [{ pointer, reason: "schema reference nesting is too deep" }];
  if (schema === true) return [];
  if (schema === false) return [{ pointer, reason: "value is rejected by a false schema" }];
  if (!isRecord(schema)) return [{ pointer, reason: "schema must be an object" }];

  const issues: ValidationIssue[] = [];

  if (hasOwn(schema, "$ref")) {
    if (typeof schema.$ref !== "string") {
      issues.push({ pointer, reason: "$ref must be a string" });
    } else {
      const resolved = store.resolve(schema.$ref, document);
      if (!resolved) {
        issues.push({ pointer, reason: `cannot resolve $ref ${JSON.stringify(schema.$ref)}` });
      } else {
        issues.push(...validate(value, resolved.schema, resolved.document, store, pointer, depth + 1));
      }
    }
  }

  if (hasOwn(schema, "type")) {
    const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      rawTypes.length === 0 ||
      rawTypes.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))
    ) {
      issues.push({ pointer, reason: "type must be a supported type string or array" });
    } else if (!rawTypes.some((type) => matchesType(value, type))) {
      const expected = rawTypes.length === 1 ? rawTypes[0] : rawTypes.join(" or ");
      return [...issues, { pointer, reason: `expected type ${expected}, got ${jsonTypeName(value)}` }];
    }
  }

  if (hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    issues.push({ pointer, reason: "value does not equal const" });
  }

  if (hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum)) {
      issues.push({ pointer, reason: "enum must be an array" });
    } else if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      issues.push({ pointer, reason: "value is not one of enum" });
    }
  }

  if (hasOwn(schema, "required")) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) {
      issues.push({ pointer, reason: "required must be an array of strings" });
    } else if (isRecord(value)) {
      for (const key of schema.required) {
        if (!hasOwn(value, key)) {
          issues.push({ pointer, reason: `missing required property ${JSON.stringify(key)}` });
        }
      }
    }
  }

  let propertySchemas: JsonObject | null = null;
  if (hasOwn(schema, "properties")) {
    if (!isRecord(schema.properties)) {
      issues.push({ pointer, reason: "properties must be an object" });
    } else {
      propertySchemas = schema.properties;
      if (isRecord(value)) {
        for (const [key, propertySchema] of Object.entries(propertySchemas)) {
          if (hasOwn(value, key)) {
            issues.push(
              ...validate(value[key], propertySchema, document, store, childPointer(pointer, key), depth + 1),
            );
          }
        }
      }
    }
  }

  if (hasOwn(schema, "additionalProperties")) {
    const additional = schema.additionalProperties;
    if (typeof additional !== "boolean" && !isRecord(additional)) {
      issues.push({ pointer, reason: "additionalProperties must be boolean or schema" });
    } else if (isRecord(value)) {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (propertySchemas && hasOwn(propertySchemas, key)) continue;
        if (additional === false) {
          issues.push({
            pointer: childPointer(pointer, key),
            reason: "additional property is not allowed",
          });
        } else if (isRecord(additional)) {
          issues.push(
            ...validate(propertyValue, additional, document, store, childPointer(pointer, key), depth + 1),
          );
        }
      }
    }
  }

  if (hasOwn(schema, "items")) {
    const itemSchema = schema.items;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        issues.push(
          ...validate(value[index], itemSchema, document, store, childPointer(pointer, index), depth + 1),
        );
      }
    }
  }

  if (hasOwn(schema, "minItems")) {
    if (typeof schema.minItems !== "number" || !Number.isFinite(schema.minItems)) {
      issues.push({ pointer, reason: "minItems must be a number" });
    } else if (Array.isArray(value) && value.length < schema.minItems) {
      issues.push({ pointer, reason: `must contain at least ${schema.minItems} item(s)` });
    }
  }

  if (hasOwn(schema, "maxItems")) {
    if (typeof schema.maxItems !== "number" || !Number.isFinite(schema.maxItems)) {
      issues.push({ pointer, reason: "maxItems must be a number" });
    } else if (Array.isArray(value) && value.length > schema.maxItems) {
      issues.push({ pointer, reason: `must contain at most ${schema.maxItems} item(s)` });
    }
  }

  if (hasOwn(schema, "minimum")) {
    if (typeof schema.minimum !== "number" || !Number.isFinite(schema.minimum)) {
      issues.push({ pointer, reason: "minimum must be a number" });
    } else if (typeof value === "number" && value < schema.minimum) {
      issues.push({ pointer, reason: `must be greater than or equal to ${schema.minimum}` });
    }
  }

  if (hasOwn(schema, "maximum")) {
    if (typeof schema.maximum !== "number" || !Number.isFinite(schema.maximum)) {
      issues.push({ pointer, reason: "maximum must be a number" });
    } else if (typeof value === "number" && value > schema.maximum) {
      issues.push({ pointer, reason: `must be less than or equal to ${schema.maximum}` });
    }
  }

  if (hasOwn(schema, "pattern")) {
    if (typeof schema.pattern !== "string") {
      issues.push({ pointer, reason: "pattern must be a string" });
    } else if (typeof value === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push({ pointer, reason: `must match pattern ${JSON.stringify(schema.pattern)}` });
        }
      } catch (error) {
        issues.push({ pointer, reason: `invalid pattern: ${oneLine(error)}` });
      }
    }
  }

  if (hasOwn(schema, "oneOf")) {
    if (!Array.isArray(schema.oneOf)) {
      issues.push({ pointer, reason: "oneOf must be an array" });
    } else {
      let matches = 0;
      for (const branch of schema.oneOf) {
        if (validate(value, branch, document, store, pointer, depth + 1).length === 0) matches += 1;
      }
      if (matches !== 1) {
        issues.push({ pointer, reason: `must match exactly one schema in oneOf (matched ${matches})` });
      }
    }
  }

  if (hasOwn(schema, "anyOf")) {
    if (!Array.isArray(schema.anyOf)) {
      issues.push({ pointer, reason: "anyOf must be an array" });
    } else {
      const matches = schema.anyOf.reduce(
        (count, branch) => count + (validate(value, branch, document, store, pointer, depth + 1).length === 0 ? 1 : 0),
        0,
      );
      if (matches === 0) issues.push({ pointer, reason: "must match at least one schema in anyOf" });
    }
  }

  return issues;
}

function validateValue(
  value: unknown,
  document: SchemaDocument,
  sourceFile: string,
  reporter: Reporter,
  store: SchemaStore,
  line?: number,
): boolean {
  const issues = validate(value, document.root, document, store, "", 0);
  for (const issue of issues) reporter.issue(sourceFile, issue.pointer, issue.reason, line);
  return issues.length === 0;
}

async function listFiles(directory: string, pattern: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of new Bun.Glob(pattern).scan({ cwd: directory, onlyFiles: true })) {
      files.push(resolve(directory, entry));
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return files.sort();
}

async function listDirectories(directory: string): Promise<string[]> {
  const directories: string[] = [];
  try {
    for await (const entry of new Bun.Glob("*").scan({ cwd: directory, onlyFiles: false })) {
      const absolute = resolve(directory, entry);
      if (await directoryExists(absolute)) directories.push(absolute);
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return directories.sort();
}

async function fileExists(file: string): Promise<boolean> {
  return Bun.file(file).exists();
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function readFile(file: string, reporter: Reporter): Promise<string | null> {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    reporter.issue(file, "", `cannot read file: ${oneLine(error)}`);
    return null;
  }
}

async function checkContracts(reporter: Reporter, store: SchemaStore): Promise<{ ok: number; failed: number }> {
  const schemaFiles = await listFiles(SCHEMAS_ROOT, "*.schema.json");
  await store.loadMany(schemaFiles);

  let ok = 0;
  let failed = 0;
  for (const schemaFile of schemaFiles) {
    const document = await store.load(schemaFile);
    const name = basename(schemaFile).replace(/\.schema\.json$/, "");
    const exampleFile = join(EXAMPLES_ROOT, `${name}.json`);

    if (!document) {
      failed += 1;
      continue;
    }
    if (!(await fileExists(exampleFile))) {
      reporter.issue(schemaFile, "", `missing example ${displayPath(exampleFile)}`);
      failed += 1;
      continue;
    }

    const source = await readFile(exampleFile, reporter);
    if (source === null) {
      failed += 1;
      continue;
    }
    const parsed = parseJsonText(source, exampleFile, reporter);
    if (!parsed.ok) {
      failed += 1;
      continue;
    }
    if (validateValue(parsed.value, document, exampleFile, reporter, store)) ok += 1;
    else failed += 1;
  }

  return { ok, failed };
}

async function fixtureSchema(
  name: string,
  store: SchemaStore,
  reporter: Reporter,
  reportMissing: boolean,
  cache: Map<string, SchemaLookup>,
): Promise<SchemaLookup> {
  const cached = cache.get(name);
  if (cached) return cached;

  const file = join(SCHEMAS_ROOT, name);
  const exists = await fileExists(file);
  if (!exists) {
    if (reportMissing) reporter.skip(file);
    const result = { exists: false, document: null };
    cache.set(name, result);
    return result;
  }

  const result = { exists: true, document: await store.load(file) };
  cache.set(name, result);
  return result;
}

async function checkJsonFile(
  file: string,
  schemaName: string,
  store: SchemaStore,
  reporter: Reporter,
  cache: Map<string, SchemaLookup>,
): Promise<CheckStatus> {
  const schema = await fixtureSchema(schemaName, store, reporter, true, cache);
  if (!schema.exists) return "skipped";
  if (!schema.document) return "failed";

  const source = await readFile(file, reporter);
  if (source === null) return "failed";
  const parsed = parseJsonText(source, file, reporter);
  if (!parsed.ok) return "failed";
  return validateValue(parsed.value, schema.document, file, reporter, store) ? "ok" : "failed";
}

async function checkJsonLines(
  file: string,
  schemaName: string,
  store: SchemaStore,
  reporter: Reporter,
  cache: Map<string, SchemaLookup>,
): Promise<CheckStatus> {
  const schema = await fixtureSchema(schemaName, store, reporter, true, cache);
  if (!schema.exists) return "skipped";
  if (!schema.document) return "failed";

  const source = await readFile(file, reporter);
  if (source === null) return "failed";

  let failed = false;
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineNumber = index + 1;
    const parsed = parseJsonText(line, file, reporter, lineNumber - 1);
    if (!parsed.ok) {
      failed = true;
      continue;
    }
    if (!validateValue(parsed.value, schema.document, file, reporter, store, lineNumber)) failed = true;
  }
  return failed ? "failed" : "ok";
}

async function checkEvents(
  file: string,
  store: SchemaStore,
  reporter: Reporter,
  cache: Map<string, SchemaLookup>,
): Promise<CheckStatus> {
  const source = await readFile(file, reporter);
  if (source === null) return "failed";

  const wrapper = await fixtureSchema("sse-line.schema.json", store, reporter, false, cache);
  let failed = false;
  let validated = false;

  const eventSchemas: Record<string, string> = {
    state: "state.schema.json",
    graph: "snapshot.schema.json",
    faults: "faults.schema.json",
    readiness: "readiness.schema.json",
    incident: "incident-commit.schema.json",
  };

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineNumber = index + 1;
    const parsed = parseJsonText(line, file, reporter, lineNumber - 1);
    if (!parsed.ok) {
      failed = true;
      continue;
    }

    if (wrapper.exists) {
      if (!wrapper.document) failed = true;
      else {
        validated = true;
        if (!validateValue(parsed.value, wrapper.document, file, reporter, store, lineNumber)) failed = true;
      }
    }

    if (!isRecord(parsed.value)) {
      reporter.issue(file, "/", "SSE line must be an object", lineNumber);
      failed = true;
      continue;
    }

    const event = parsed.value.event;
    if (typeof event !== "string") {
      reporter.issue(file, "/event", "SSE event must be a string", lineNumber);
      failed = true;
      continue;
    }

    const schemaName = eventSchemas[event];
    if (!schemaName) {
      reporter.issue(file, "/event", `unsupported SSE event ${JSON.stringify(event)}`, lineNumber);
      failed = true;
      continue;
    }

    const dataSchema = await fixtureSchema(schemaName, store, reporter, true, cache);
    if (!dataSchema.exists) continue;
    if (!dataSchema.document) {
      failed = true;
      continue;
    }
    validated = true;
    const data = hasOwn(parsed.value, "data") ? parsed.value.data : undefined;
    if (!validateValue(data, dataSchema.document, file, reporter, store, lineNumber)) failed = true;

    if (event === "incident" && isRecord(data) && isRecord(data.event) && data.event.type === "hypothesis.concluded") {
      const payload = data.event.payload;
      if (isRecord(payload) && hasOwn(payload, "hypothesis")) {
        const agentReport = await fixtureSchema("agent-report.schema.json", store, reporter, true, cache);
        if (!agentReport.document) {
          failed = true;
        } else {
          validated = true;
          if (!validateValue(payload.hypothesis, agentReport.document, file, reporter, store, lineNumber)) failed = true;
        }
      }
    }
  }

  if (failed) return "failed";
  return validated ? "ok" : "skipped";
}

async function checkFixtures(reporter: Reporter, store: SchemaStore): Promise<{
  dirs: number;
  ok: number;
  failed: number;
}> {
  if (!(await directoryExists(FIXTURES_ROOT))) {
    reporter.skip(FIXTURES_ROOT);
    return { dirs: 0, ok: 0, failed: 0 };
  }

  const directories = await listDirectories(FIXTURES_ROOT);
  const cache = new Map<string, SchemaLookup>();
  let ok = 0;
  let failed = 0;

  const record = (status: CheckStatus): void => {
    if (status === "ok") ok += 1;
    if (status === "failed") failed += 1;
  };

  for (const directory of directories) {
    const stateInitialFile = join(directory, "state.initial.json");
    const stateFile = join(directory, "state.json");
    const snapshotsFile = join(directory, "snapshots.jsonl");
    const eventsFile = join(directory, "events.jsonl");
    const reportFile = join(directory, "report.json");
    const timelineFile = join(directory, "timeline.json");

    const requiredFiles: Array<[string, () => Promise<CheckStatus>]> = [
      [stateInitialFile, () => checkJsonFile(stateInitialFile, "state.schema.json", store, reporter, cache)],
      [stateFile, () => checkJsonFile(stateFile, "state.schema.json", store, reporter, cache)],
      [snapshotsFile, () => checkJsonLines(snapshotsFile, "snapshot.schema.json", store, reporter, cache)],
      [eventsFile, () => checkEvents(eventsFile, store, reporter, cache)],
      [reportFile, () => checkJsonFile(reportFile, "report.schema.json", store, reporter, cache)],
      [timelineFile, () => checkJsonFile(timelineFile, "timeline.schema.json", store, reporter, cache)],
    ];

    for (const [file, check] of requiredFiles) {
      if (await fileExists(file)) {
        record(await check());
      } else {
        reporter.issue(file, "", "missing required fixture file");
        failed += 1;
      }
    }
  }

  return { dirs: directories.length, ok, failed };
}

function parseYaml(source: string, file: string, reporter: Reporter): Parsed<unknown> {
  try {
    return { ok: true, value: Bun.YAML.parse(source) };
  } catch (error) {
    reporter.issue(file, "", `invalid YAML: ${oneLine(error)}`, lineFromParseError(error, source, 0));
    return { ok: false };
  }
}

async function checkDeployPair(
  dataFile: string,
  schemaFile: string,
  store: SchemaStore,
  reporter: Reporter,
): Promise<CheckStatus> {
  const dataExists = await fileExists(dataFile);
  const schemaExists = await fileExists(schemaFile);
  if (!dataExists) reporter.skip(dataFile);
  if (!schemaExists) reporter.skip(schemaFile);
  if (!dataExists || !schemaExists) return "skipped";

  const document = await store.load(schemaFile);
  if (!document) return "failed";

  const source = await readFile(dataFile, reporter);
  if (source === null) return "failed";
  const parsed = parseYaml(source, dataFile, reporter);
  if (!parsed.ok) return "failed";
  return validateValue(parsed.value, document, dataFile, reporter, store) ? "ok" : "failed";
}

async function checkDeploy(reporter: Reporter, store: SchemaStore): Promise<{ ok: number; failed: number }> {
  const pairs: Array<[string, string]> = [
    [join(DEPLOY_ROOT, "manifest.yaml"), join(SCHEMAS_ROOT, "manifest.schema.json")],
    [join(DEPLOY_ROOT, "cards.yaml"), join(SCHEMAS_ROOT, "cards.schema.json")],
  ];

  let ok = 0;
  let failed = 0;
  for (const [dataFile, schemaFile] of pairs) {
    const status = await checkDeployPair(dataFile, schemaFile, store, reporter);
    if (status === "ok") ok += 1;
    if (status === "failed") failed += 1;
  }
  return { ok, failed };
}

export { SchemaStore, Reporter, validateValue, listFiles, SCHEMAS_ROOT };

async function main(): Promise<void> {
  const reporter = new Reporter();
  const store = new SchemaStore(reporter);

  const schemas = await checkContracts(reporter, store);
  const fixtures = await checkFixtures(reporter, store);
  const deploy = await checkDeploy(reporter, store);

  reporter.print();
  console.log(`schemas: ${schemas.ok} ok, ${schemas.failed} failed`);
  console.log(`fixtures: ${fixtures.dirs} dirs, ${fixtures.ok} files ok, ${fixtures.failed} failed`);
  console.log(`deploy: ${deploy.ok} ok, ${deploy.failed} failed`);

  if (schemas.failed > 0 || fixtures.failed > 0 || deploy.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
