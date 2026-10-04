/**
 * The only module in core that touches the machine: files, git and process
 * info. Everything else is pure and can run anywhere.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  caseResultSchema,
  datasetCaseSchema,
  evaluationRecordSchema,
  manifestSchema,
  type CaseResult,
  type EvaluationRecord,
  type Manifest,
} from "./artifact.ts";
import type { Run } from "./runner.ts";
import type { Case, Dataset, Scenario } from "./types.ts";

type DatasetSchemas<I, E> = Pick<Scenario<I, unknown, E>, "inputSchema" | "expectedSchema">;

export interface StoredRun {
  dir: string;
  manifest: Manifest;
  /** dataset.jsonl exactly as it was snapshotted. */
  datasetText: string;
  results: CaseResult[];
  /** null when the run has not been evaluated. */
  evaluations: EvaluationRecord[] | null;
}

// --- Datasets ----------------------------------------------------------------

export async function loadDataset<I, E>(
  scenario: DatasetSchemas<I, E> & Pick<Scenario<I, unknown, E>, "id" | "datasets">,
  name: string,
): Promise<Dataset<I, E>> {
  const location = scenario.datasets[name];
  if (!location) {
    const available = Object.keys(scenario.datasets).join(", ");
    throw new Error(`scenario "${scenario.id}" has no dataset "${name}" (available: ${available})`);
  }
  return parseDataset(scenario, name, await readFile(location, "utf8"));
}

/** Parses JSONL with one case per line. Any invalid line fails the whole dataset. */
export function parseDataset<I, E>(
  scenario: DatasetSchemas<I, E>,
  name: string,
  text: string,
): Dataset<I, E> {
  const seen = new Set<string>();
  const cases = parseJsonl(text, datasetCaseSchema, `dataset "${name}"`, (record, where) => {
    if (seen.has(record.id)) throw new Error(`${where}: duplicate case id "${record.id}"`);
    seen.add(record.id);

    const input = scenario.inputSchema.safeParse(record.input);
    if (!input.success) throw new Error(`${where}: input is invalid: ${input.error.message}`);
    const c: Case<I, E> = { id: record.id, input: input.data };

    if (record.expected !== undefined) {
      const expected = scenario.expectedSchema.safeParse(record.expected);
      if (!expected.success) throw new Error(`${where}: expected is invalid: ${expected.error.message}`);
      c.expected = expected.data;
    }
    if (record.tags) c.tags = record.tags;
    return c;
  });
  return { name, sha256: sha256(text), text, cases };
}

// --- Runs --------------------------------------------------------------------

/**
 * Writes a run to `<runsDir>/<runId>/` and returns that directory. Every record
 * is validated first, and an existing run is never overwritten.
 */
export async function writeRun(
  runsDir: string,
  run: Run,
  dataset: Pick<Dataset<unknown, unknown>, "text">,
): Promise<string> {
  const manifest = manifestSchema.parse(run.manifest);
  const results = run.results.map((result) => caseResultSchema.parse(result));
  checkAgainstManifest(manifest, dataset.text, results);

  const dir = join(runsDir, manifest.runId);
  await mkdir(runsDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`run "${manifest.runId}" already exists in ${runsDir}`);
    }
    throw error;
  }

  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, "dataset.jsonl"), dataset.text);
  await writeFile(join(dir, "results.jsonl"), toJsonl(results));
  return dir;
}

/** Replaces the run's evaluations. They can always be recomputed from the results. */
export async function writeEvaluations(dir: string, evaluations: EvaluationRecord[]): Promise<void> {
  const records = evaluations.map((record) => evaluationRecordSchema.parse(record));
  await writeFile(join(dir, "evaluations.jsonl"), toJsonl(records));
}

/** Reads a run back, refusing one whose files no longer agree with its manifest. */
export async function loadRun(dir: string): Promise<StoredRun> {
  const manifestText = await readIfPresent(join(dir, "manifest.json"));
  if (manifestText === null) throw new Error(`no run found at ${dir}`);
  const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
  if (!parsed.success) throw new Error(`${dir}/manifest.json: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;

  const datasetText = await readFile(join(dir, "dataset.jsonl"), "utf8");
  const results = parseJsonl(
    await readFile(join(dir, "results.jsonl"), "utf8"),
    caseResultSchema,
    `${dir}/results.jsonl`,
  );
  checkAgainstManifest(manifest, datasetText, results);

  const evaluationsText = await readIfPresent(join(dir, "evaluations.jsonl"));
  const evaluations =
    evaluationsText === null
      ? null
      : parseJsonl(evaluationsText, evaluationRecordSchema, `${dir}/evaluations.jsonl`);
  return { dir, manifest, datasetText, results, evaluations };
}

function checkAgainstManifest(manifest: Manifest, datasetText: string, results: CaseResult[]): void {
  if (sha256(datasetText) !== manifest.dataset.sha256) {
    throw new Error("the dataset does not match the hash recorded in the manifest");
  }
  if (results.length !== manifest.dataset.caseCount) {
    throw new Error(`expected ${manifest.dataset.caseCount} results, got ${results.length}`);
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
