/**
 * The only module in core that touches the machine: files, git and process
 * info. Everything else is pure and can run anywhere.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { caseResultSchema, datasetCaseSchema, manifestSchema, type Manifest } from "./artifact.ts";
import type { Run } from "./runner.ts";
import type { Case, Dataset, Scenario } from "./types.ts";

type DatasetSchemas<I, E> = Pick<Scenario<I, unknown, E>, "inputSchema" | "expectedSchema">;

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
  const cases: Case<I, E>[] = [];
  const seen = new Set<string>();

  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `dataset "${name}", line ${index + 1}`;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const record = datasetCaseSchema.safeParse(raw);
    if (!record.success) throw new Error(`${where}: ${z.prettifyError(record.error)}`);
    if (seen.has(record.data.id)) throw new Error(`${where}: duplicate case id "${record.data.id}"`);
    seen.add(record.data.id);

    const input = scenario.inputSchema.safeParse(record.data.input);
    if (!input.success) throw new Error(`${where}: input is invalid: ${input.error.message}`);
    const c: Case<I, E> = { id: record.data.id, input: input.data };

    if (record.data.expected !== undefined) {
      const expected = scenario.expectedSchema.safeParse(record.data.expected);
      if (!expected.success) throw new Error(`${where}: expected is invalid: ${expected.error.message}`);
      c.expected = expected.data;
    }
    if (record.data.tags) c.tags = record.data.tags;
    cases.push(c);
  });

  return { name, sha256: sha256(text), text, cases };
}

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
  if (sha256(dataset.text) !== manifest.dataset.sha256) {
    throw new Error("the dataset does not match the hash recorded in the manifest");
  }
  if (results.length !== manifest.dataset.caseCount) {
    throw new Error(`expected ${manifest.dataset.caseCount} results, got ${results.length}`);
  }

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
  await writeFile(join(dir, "results.jsonl"), results.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return dir;
}

/** Records where a run was executed. `git` is null when `cwd` is not in a checkout with a commit. */
export function readEnvironment(cwd: string = process.cwd()): Manifest["environment"] {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    git: readGit(cwd),
  };
}

function readGit(cwd: string): Manifest["environment"]["git"] {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
