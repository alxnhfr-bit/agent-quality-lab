/**
 * What each command does, apart from parsing arguments and printing. Every
 * number shown comes from core; this file only wires core functions together.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  comparability,
  compare,
  evaluateRun,
  executeRun,
  summarize,
  type Candidate,
  type Scenario,
} from "@agent-quality-lab/core";
import {
  loadDataset,
  loadRun,
  openRun,
  parseDataset,
  readEnvironment,
  stackRelativeTo,
  writeEvaluations,
  type RunWriter,
} from "@agent-quality-lab/core/store";
import { renderComparison, renderRun } from "./render.ts";
import { renderHtmlReport } from "./report/html.ts";

/** A mistake in how the command was used. Shown as a message, without a stack trace. */
export class UsageError extends Error {}

/** A run that ended before every case had run, for example at its spending limit. */
export class RunStopped extends Error {}

/** In US dollars. Only candidates that call a paid model can reach it. */
export const DEFAULT_MAX_COST = 5;

export interface Project {
  /** Where scenarios/ lives. Stack traces in runs are recorded relative to it. */
  root: string;
  runsDir: string;
}

type AnyScenario = Scenario<unknown, unknown, unknown, unknown>;
type AnyCandidate = Candidate<unknown, unknown>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RunArgs {
  scenario: string;
  candidate: string;
  dataset?: string | undefined;
  /** How many cases to run at the same time. */
  concurrency?: number | undefined;
  /** Stop the run once its model calls have cost more than this many US dollars. */
  maxCost?: number | undefined;
}

export async function runCommand(
  project: Project,
  args: RunArgs,
  progress: (line: string) => void,
): Promise<string> {
  const scenario = await loadScenario(project.root, args.scenario);
  const candidate = await loadCandidate(project.root, args.scenario, args.candidate);
  const dataset = await loadDataset(scenario, datasetName(scenario, args.dataset));

  // Each result goes to disk as it arrives, so a run that is interrupted keeps what it had.
  let writer: RunWriter | undefined;
  const run = await executeRun(scenario, candidate, dataset, {
    environment: readEnvironment(project.root),
    cleanStack: stackRelativeTo(project.root),
    concurrency: args.concurrency ?? 1,
    maxCost: args.maxCost ?? DEFAULT_MAX_COST,
    onStart: async (manifest) => {
      writer = await openRun(project.runsDir, manifest, dataset);
    },
    onCaseDone: async (result, done, total) => {
      await writer!.append(result);
      progress(`[${done}/${total}] ${result.caseId}: ${result.status}`);
    },
  });
  await writer!.finish(run.manifest);

  if (run.manifest.stopped) {
    const stopped = `run ${run.manifest.runId} was stopped: ${run.manifest.stopped.reason}`;
    if (run.results.length === 0) {
      // Nothing ran, so there is no evidence to keep.
      rmSync(writer!.dir, { recursive: true });
      throw new RunStopped(`${stopped}\nNo case ran, so nothing was saved.`);
    }
    throw new RunStopped(
      `${stopped}\n${run.results.length} of ${dataset.cases.length} cases are saved in ${writer!.dir}. ` +
        "The run is incomplete, so it is not scored and cannot be compared.",
    );
  }

  const evaluations = await evaluateRun(scenario, dataset.cases, run.results);
  await writeEvaluations(writer!.dir, evaluations);

  return renderRun({
    manifest: run.manifest,
    results: run.results,
    evaluations,
    summary: summarize(run.results, evaluations, dataset.cases, run.manifest.prices),
  });
}

export async function evalCommand(project: Project, args: { run: string }): Promise<string> {
  const dir = findRun(project, args.run);
  const run = await loadRun(dir);
  if (!run.complete) {
    const why = run.manifest.stopped ? `: ${run.manifest.stopped.reason}` : "";
    throw new UsageError(
      `run ${run.manifest.runId} is incomplete, with ${run.results.length} of ${run.manifest.dataset.caseCount} cases${why}`,
    );
  }

  const scenario = await loadScenario(project.root, run.manifest.scenario.id);
  // Scored against the cases the run actually used, not whatever the dataset contains today.
  const dataset = parseDataset(scenario, run.manifest.dataset.name, run.datasetText);
  const evaluations = await evaluateRun(scenario, dataset.cases, run.results);
  await writeEvaluations(dir, evaluations);

  const notes =
    scenario.version === run.manifest.scenario.version
      ? []
      : [
          `this run was executed with scenario version ${run.manifest.scenario.version}; ` +
            `it was scored with the evaluators of version ${scenario.version}`,
        ];
  return renderRun({
    manifest: run.manifest,
    results: run.results,
    evaluations,
    summary: summarize(run.results, evaluations, dataset.cases, run.manifest.prices),
    notes,
  });
}

export async function compareCommand(
  project: Project,
  args: { a: string; b: string; html?: string | undefined },
): Promise<string> {
  const [a, b] = await Promise.all([loadRun(findRun(project, args.a)), loadRun(findRun(project, args.b))]);
  const reasons = comparability(a, b);
  if (reasons.length > 0) {
    throw new UsageError(`these runs cannot be compared:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`);
  }
  const comparison = compare(a, b);
  const text = renderComparison(comparison, a, b);
  if (args.html === undefined) return text;

  writeFileSync(args.html, renderHtmlReport({ comparison, a, b }));
  return `${text}\n\nHTML report written to ${args.html}`;
}

/** A run is named by its id, or by a path to its directory. */
function findRun(project: Project, run: string): string {
  const dir = existsSync(run) ? resolve(run) : join(project.runsDir, run);
  if (!existsSync(join(dir, "manifest.json"))) throw new UsageError(`no run found at ${dir}`);
  return dir;
}

function datasetName(scenario: AnyScenario, requested: string | undefined): string {
  const available = Object.keys(scenario.datasets);
  if (requested === undefined) {
    if (available.length === 1) return available[0]!;
    throw new UsageError(`choose a dataset with --dataset (available: ${available.join(", ")})`);
  }
  if (!available.includes(requested)) {
    throw new UsageError(
      `scenario "${scenario.id}" has no dataset "${requested}" (available: ${available.join(", ")})`,
    );
  }
  return requested;
}

async function loadScenario(root: string, name: string): Promise<AnyScenario> {
  const path = join(root, "scenarios", name, "scenario.ts");
  if (!NAME.test(name) || !existsSync(path)) {
    const available = directoryNames(join(root, "scenarios")).filter((dir) =>
      existsSync(join(root, "scenarios", dir, "scenario.ts")),
    );
    throw new UsageError(`no scenario "${name}" (available: ${available.join(", ") || "none"})`);
  }
  const scenario: unknown = (await import(pathToFileURL(path).href)).default;
  if (!isScenario(scenario)) throw new UsageError(`scenarios/${name}/scenario.ts must default-export a scenario`);
  if (scenario.id !== name) {
    throw new UsageError(`scenarios/${name}/scenario.ts has the id "${scenario.id}"; it must match its directory`);
  }
  return scenario;
}

/**
 * A candidate is looked for among the scenario's own first, then among the ones
 * that work for any scenario, in candidates/ at the project root.
 */
async function loadCandidate(root: string, scenario: string, name: string): Promise<AnyCandidate> {
  const dirs = [join(root, "scenarios", scenario, "candidates"), join(root, "candidates")];
  const path = dirs.map((dir) => join(dir, `${name}.ts`)).find((file) => existsSync(file));
  if (!NAME.test(name) || !path) {
    const available = dirs.flatMap((dir) =>
      fileNames(dir)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => file.slice(0, -".ts".length)),
    );
    throw new UsageError(
      `scenario "${scenario}" has no candidate "${name}" (available: ${available.join(", ") || "none"})`,
    );
  }
  const candidate: unknown = (await import(pathToFileURL(path).href)).default;
  if (!isCandidate(candidate)) {
    throw new UsageError(`${relative(root, path)} must default-export a candidate`);
  }
  return candidate;
}

function isScenario(value: unknown): value is AnyScenario {
  const scenario = value as Partial<AnyScenario> | null;
  return (
    typeof scenario?.id === "string" &&
    typeof scenario.version === "string" &&
    typeof scenario.instructions === "string" &&
    typeof scenario.datasets === "object" &&
    Array.isArray(scenario.evaluators) &&
    typeof scenario.timeoutMs === "number"
  );
}

function isCandidate(value: unknown): value is AnyCandidate {
  const candidate = value as Partial<AnyCandidate> | null;
  return (
    typeof candidate?.id === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.deterministic === "boolean" &&
    typeof candidate.run === "function"
  );
}

function directoryNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function fileNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}
