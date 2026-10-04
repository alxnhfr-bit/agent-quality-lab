/**
 * What each command does, apart from parsing arguments and printing. Every
 * number shown comes from core; this file only wires core functions together.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  parseDataset,
  readEnvironment,
  stackRelativeTo,
  writeEvaluations,
  writeRun,
} from "@agent-quality-lab/core/store";
import { renderComparison, renderRun } from "./render.ts";
import { renderHtmlReport } from "./report/html.ts";

/** A mistake in how the command was used. Shown as a message, without a stack trace. */
export class UsageError extends Error {}

export interface Project {
  /** Where scenarios/ lives. Stack traces in runs are recorded relative to it. */
  root: string;
  runsDir: string;
}

type AnyScenario = Scenario<unknown, unknown, unknown>;
type AnyCandidate = Candidate<unknown, unknown>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function runCommand(
  project: Project,
  args: { scenario: string; candidate: string; dataset?: string | undefined },
  progress: (line: string) => void,
): Promise<string> {
  const scenario = await loadScenario(project.root, args.scenario);
  const candidate = await loadCandidate(project.root, args.scenario, args.candidate);
  const dataset = await loadDataset(scenario, datasetName(scenario, args.dataset));

  const run = await executeRun(scenario, candidate, dataset, {
    environment: readEnvironment(project.root),
    cleanStack: stackRelativeTo(project.root),
    onCaseDone: (result, done, total) => progress(`[${done}/${total}] ${result.caseId}: ${result.status}`),
  });
  // Written before scoring, so the evidence survives a failure in an evaluator.
  const dir = await writeRun(project.runsDir, run, dataset);
  const evaluations = await evaluateRun(scenario, dataset.cases, run.results);
  await writeEvaluations(dir, evaluations);

  return renderRun({
    manifest: run.manifest,
    results: run.results,
    evaluations,
    summary: summarize(run.results, evaluations),
  });
}

export async function evalCommand(project: Project, args: { run: string }): Promise<string> {
  const dir = findRun(project, args.run);
  const run = await loadRun(dir);

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
    summary: summarize(run.results, evaluations),
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

  writeFileSync(args.html, renderHtmlReport({ comparison, a, b, cases: a.cases }));
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

async function loadCandidate(root: string, scenario: string, name: string): Promise<AnyCandidate> {
  const dir = join(root, "scenarios", scenario, "candidates");
  const path = join(dir, `${name}.ts`);
  if (!NAME.test(name) || !existsSync(path)) {
    const available = fileNames(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.slice(0, -".ts".length));
    throw new UsageError(
      `scenario "${scenario}" has no candidate "${name}" (available: ${available.join(", ") || "none"})`,
    );
  }
  const candidate: unknown = (await import(pathToFileURL(path).href)).default;
  if (!isCandidate(candidate)) {
    throw new UsageError(`scenarios/${scenario}/candidates/${name}.ts must default-export a candidate`);
  }
  return candidate;
}

function isScenario(value: unknown): value is AnyScenario {
  const scenario = value as Partial<AnyScenario> | null;
  return (
    typeof scenario?.id === "string" &&
    typeof scenario.version === "string" &&
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
