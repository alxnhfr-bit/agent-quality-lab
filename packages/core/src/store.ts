/**
 * The only module in core that touches the machine: files, git and process
 * info. Everything else is pure and can run anywhere.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  caseResultSchema,
  datasetCaseSchema,
  evaluationRecordSchema,
  manifestSchema,
  type CaseResult,
  type DatasetCase,
  type EvaluationRecord,
  type Manifest,
} from "./artifact.ts";
import type { Run } from "./runner.ts";
import type { Case, Dataset, Scenario } from "./types.ts";

type DatasetSchemas<I, E, S> = Pick<
  Scenario<I, unknown, E, S>,
  "inputSchema" | "expectedSchema" | "setupSchema"
>;

export interface StoredRun {
  dir: string;
  manifest: Manifest;
  /** dataset.jsonl exactly as it was snapshotted. */
  datasetText: string;
  /** The same cases as plain JSON, not typed by any scenario. */
  cases: DatasetCase[];
  results: CaseResult[];
  /** null when the run has not been evaluated. */
  evaluations: EvaluationRecord[] | null;
  /** False for a run that was interrupted or stopped before every case had run. */
  complete: boolean;
}

// --- Datasets ----------------------------------------------------------------

export async function loadDataset<I, E, S>(
  scenario: DatasetSchemas<I, E, S> & Pick<Scenario<I, unknown, E, S>, "id" | "datasets">,
  name: string,
): Promise<Dataset<I, E, S>> {
  const location = scenario.datasets[name];
  if (!location) {
    const available = Object.keys(scenario.datasets).join(", ");
    throw new Error(`scenario "${scenario.id}" has no dataset "${name}" (available: ${available})`);
  }
  return parseDataset(scenario, name, await readFile(location, "utf8"));
}

/** Parses JSONL with one case per line. Any invalid line fails the whole dataset. */
export function parseDataset<I, E, S>(
  scenario: DatasetSchemas<I, E, S>,
  name: string,
  text: string,
): Dataset<I, E, S> {
  const seen = new Set<string>();
  const cases = parseJsonl(text, datasetCaseSchema, `dataset "${name}"`, (record, where) => {
    if (seen.has(record.id)) throw new Error(`${where}: duplicate case id "${record.id}"`);
    seen.add(record.id);

    const input = scenario.inputSchema.safeParse(record.input);
    if (!input.success) throw new Error(`${where}: input is invalid: ${input.error.message}`);
    const c: Case<I, E, S> = { id: record.id, input: input.data };

    if (record.expected !== undefined) {
      const expected = scenario.expectedSchema.safeParse(record.expected);
      if (!expected.success) throw new Error(`${where}: expected is invalid: ${expected.error.message}`);
      c.expected = expected.data;
    }
    if (scenario.setupSchema) {
      const setup = scenario.setupSchema.safeParse(record.setup);
      if (!setup.success) throw new Error(`${where}: setup is invalid: ${setup.error.message}`);
      if (setup.data !== undefined) c.setup = setup.data;
    } else if (record.setup !== undefined) {
      throw new Error(`${where}: the case has a setup, but the scenario does not define one`);
    }
    if (record.tags) c.tags = record.tags;
    return c;
  });
  return { name, sha256: sha256(text), text, cases };
}

// --- Runs --------------------------------------------------------------------

export interface RunWriter {
  dir: string;
  /** Adds one result. It is on disk when this returns. */
  append(result: CaseResult): Promise<void>;
  /** Replaces the manifest written at the start with the final one. */
  finish(manifest: Manifest): Promise<void>;
}

/**
 * Starts a run on disk at `<runsDir>/<runId>/`, so that each result can be
 * saved as it arrives and an interrupted run keeps what it had. An existing run
 * is never overwritten.
 */
export async function openRun(
  runsDir: string,
  manifest: Manifest,
  dataset: Pick<Dataset<unknown, unknown>, "text">,
): Promise<RunWriter> {
  const started = manifestSchema.parse(manifest);
  if (sha256(dataset.text) !== started.dataset.sha256) {
    throw new Error("the dataset does not match the hash recorded in the manifest");
  }

  const dir = join(runsDir, started.runId);
  await mkdir(runsDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`run "${started.runId}" already exists in ${runsDir}`);
    }
    throw error;
  }

  const writeManifest = (m: Manifest) => writeFile(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  await writeManifest(started);
  await writeFile(join(dir, "dataset.jsonl"), dataset.text);
  await writeFile(join(dir, "results.jsonl"), "");
  return {
    dir,
    append: (result) => appendFile(join(dir, "results.jsonl"), toJsonl([caseResultSchema.parse(result)])),
    finish: (final) => writeManifest(manifestSchema.parse(final)),
  };
}

/**
 * Writes a finished run in one go and returns its directory. Every record is
 * validated before anything is written.
 */
export async function writeRun(
  runsDir: string,
  run: Run,
  dataset: Pick<Dataset<unknown, unknown>, "text">,
): Promise<string> {
  const manifest = manifestSchema.parse(run.manifest);
  const results = run.results.map((result) => caseResultSchema.parse(result));
  checkCount(manifest, results);

  const writer = await openRun(runsDir, manifest, dataset);
  for (const result of results) await writer.append(result);
  await writer.finish(manifest);
  return writer.dir;
}

/** Replaces the run's evaluations. They can always be recomputed from the results. */
export async function writeEvaluations(dir: string, evaluations: EvaluationRecord[]): Promise<void> {
  const records = evaluations.map((record) => evaluationRecordSchema.parse(record));
  await writeFile(join(dir, "evaluations.jsonl"), toJsonl(records));
}

/**
 * Reads a run back, refusing one whose files no longer agree with its manifest.
 * A run that was interrupted or stopped loads too, marked as not complete.
 */
export async function loadRun(dir: string): Promise<StoredRun> {
  const manifestText = await readIfPresent(join(dir, "manifest.json"));
  if (manifestText === null) throw new Error(`no run found at ${dir}`);
  const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
  if (!parsed.success) throw new Error(`${dir}/manifest.json: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;

  const datasetText = await readFile(join(dir, "dataset.jsonl"), "utf8");
  if (sha256(datasetText) !== manifest.dataset.sha256) {
    throw new Error("the dataset does not match the hash recorded in the manifest");
  }
  const cases = parseJsonl(datasetText, datasetCaseSchema, `${dir}/dataset.jsonl`);

  // Results are saved in the order the cases finished; they are handed back in dataset order.
  const position = new Map(cases.map((c, index) => [c.id, index]));
  const results = parseJsonl(
    await readFile(join(dir, "results.jsonl"), "utf8"),
    caseResultSchema,
    `${dir}/results.jsonl`,
  );
  for (const { caseId } of results) {
    if (!position.has(caseId)) {
      throw new Error(`${dir}/results.jsonl has a result for "${caseId}", which is not in the dataset`);
    }
  }
  if (new Set(results.map((result) => result.caseId)).size !== results.length) {
    throw new Error(`${dir}/results.jsonl has more than one result for a case`);
  }
  results.sort((a, b) => position.get(a.caseId)! - position.get(b.caseId)!);
  checkCount(manifest, results);

  const evaluationsText = await readIfPresent(join(dir, "evaluations.jsonl"));
  const evaluations =
    evaluationsText === null
      ? null
      : parseJsonl(evaluationsText, evaluationRecordSchema, `${dir}/evaluations.jsonl`);
  return { dir, manifest, datasetText, cases, results, evaluations, complete: isComplete(manifest, results) };
}

/** A run is complete when it ran to its end and every case has a result. */
export function isComplete(manifest: Manifest, results: readonly CaseResult[]): boolean {
  return (
    manifest.finishedAt !== undefined &&
    manifest.stopped === undefined &&
    results.length === manifest.dataset.caseCount
  );
}

/** A run that says it ran to its end must have a result for every case. */
function checkCount(manifest: Manifest, results: readonly CaseResult[]): void {
  const expected = manifest.dataset.caseCount;
  const claimsToBeWhole = manifest.finishedAt !== undefined && manifest.stopped === undefined;
  if (results.length > expected || (claimsToBeWhole && results.length !== expected)) {
    throw new Error(`expected ${expected} results, got ${results.length}`);
  }
}

// --- The machine -------------------------------------------------------------

/** Records where a run was executed. `git` is null when `cwd` is not in a checkout with a commit. */
export function readEnvironment(cwd: string = process.cwd()): Manifest["environment"] {
  let checkout: Manifest["environment"]["git"];
  try {
    checkout = { commit: git(cwd, "rev-parse", "HEAD"), dirty: git(cwd, "status", "--porcelain") !== "" };
  } catch {
    checkout = null;
  }
  return { node: process.version, platform: `${process.platform}-${process.arch}`, git: checkout };
}

/** The git checkout that contains `cwd`, or `cwd` itself when there is none. */
export function projectRoot(cwd: string = process.cwd()): string {
  try {
    return git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    return cwd;
  }
}

/**
 * Rewrites paths under `root` in a stack trace as relative ones, so a run does
 * not record where on disk it happened. Paths outside `root` are left as they are.
 */
export function stackRelativeTo(root: string): (stack: string) => string {
  const dir = root.endsWith(sep) ? root : `${root}${sep}`;
  const url = pathToFileURL(dir).href;
  return (stack) => stack.replaceAll(url, "").replaceAll(dir, "");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// --- Helpers -----------------------------------------------------------------

function parseJsonl<T>(text: string, schema: z.ZodType<T>, source: string): T[];
function parseJsonl<T, R>(
  text: string,
  schema: z.ZodType<T>,
  source: string,
  convert: (record: T, where: string) => R,
): R[];
function parseJsonl<T, R>(
  text: string,
  schema: z.ZodType<T>,
  source: string,
  convert?: (record: T, where: string) => R,
): (T | R)[] {
  const records: (T | R)[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `${source}, line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const record = schema.safeParse(raw);
    if (!record.success) throw new Error(`${where}: ${z.prettifyError(record.error)}`);
    records.push(convert ? convert(record.data, where) : record.data);
  });
  return records;
}

function toJsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
