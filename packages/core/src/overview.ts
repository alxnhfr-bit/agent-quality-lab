/**
 * Every system that ran on one dataset, with each check as a range over its
 * runs. Runs of the same system, on the same task under the same conditions,
 * are repeats of each other: how far they spread is how much a result moves by
 * itself, and only a difference wider than that is called one.
 *
 * The rule is deliberately simple. A difference is called when two systems
 * each ran at least MIN_RUNS times, every run has an answer for every case,
 * and their ranges on a check do not overlap. Anything less is reported as
 * what it is: not enough runs, answers missing, or ranges that overlap.
 *
 * Counting only, from stored runs; nothing here runs or judges anything.
 */
import type { Manifest } from "./artifact.ts";
import { comparability, type RunData } from "./compare.ts";
import { passRate, summarize, type SliceSummary } from "./summary.ts";

/** The fewest runs of each system before the lab calls a difference between them. */
export const MIN_RUNS = 3;

/** One check in one run: passes out of the answers it judged, and the cases without an answer beside them. */
export interface Share {
  pass: number;
  of: number;
  unanswered: number;
}

/** One check over all of a system's runs. */
export interface Spread {
  /** Per run, in the order of the system's `runIds`. */
  runs: Share[];
  /** The lowest and highest share of judged answers that passed, over the runs where the check judged any. */
  low: number | null;
  high: number | null;
  /** Some run has cases without an answer. */
  unanswered: boolean;
}

/**
 * How steady one check's verdicts were across a system's runs, case by case,
 * over the runs where the check applied. A case without an answer in some run
 * is listed apart: a missing answer is not the system changing its mind.
 */
export interface Steadiness {
  passedEveryTime: string[];
  failedEveryTime: string[];
  /** Cases that passed in some runs and not in others. */
  varied: { caseId: string; passed: number; of: number }[];
  /** Cases without an answer in at least one run. */
  unanswered: string[];
}

export interface SystemOverview {
  /** The candidate's id, with its version when two systems share an id. */
  name: string;
  candidate: Manifest["candidate"];
  /** Oldest first. */
  runIds: string[];
  /** Every run has an answer for every case. */
  answered: boolean;
  /** By check id. */
  checks: Record<string, Spread>;
  /** By tag, then by check id. */
  byTag: Record<string, Record<string, Spread>>;
  /** By check id. Only for a system with more than one run. */
  steadiness?: Record<string, Steadiness>;
}

export interface Overview {
  scenario: Manifest["scenario"];
  dataset: Manifest["dataset"];
  /** Check ids, in the order the runs list them. */
  checks: string[];
  /** The tags the cases carry, with how many cases carry each. */
  tags: { tag: string; cases: number }[];
  /** Most runs first. */
  systems: SystemOverview[];
  /** Systems with enough runs, every case answered in each, for a difference to be called. */
  eligible: string[];
  /** Ranges that lie apart: `higher` did better than `lower` on the check. */
  differences: { check: string; higher: string; lower: string }[];
  /** Eligible systems whose ranges overlap on a check. */
  overlaps: { a: string; b: string; check: string }[];
  /** Eligible systems that cannot be compared at all, and why. */
  incomparable: { a: string; b: string; reasons: string[] }[];
  /** Runs that are not in the overview, and why. */
  leftOut: { runId: string; reason: string }[];
}

export function overview(runs: readonly RunData[]): Overview {
  const oldestFirst = runs.toSorted((x, y) => x.manifest.startedAt.localeCompare(y.manifest.startedAt));
  const latest = oldestFirst.at(-1);
  if (!latest) throw new Error("there are no runs to give an overview of");
  const { scenario, dataset } = latest.manifest;
  if (oldestFirst.some((run) => run.manifest.scenario.id !== scenario.id || run.manifest.dataset.name !== dataset.name)) {
    throw new Error("an overview is of one scenario and one dataset");
  }

  const leftOut: Overview["leftOut"] = [];
  const groups: RunData[][] = [];
  for (const run of oldestFirst) {
    if (run.manifest.dataset.sha256 !== dataset.sha256) {
      leftOut.push({ runId: run.manifest.runId, reason: "it ran on an earlier version of the dataset" });
      continue;
    }
    // A run that is incomplete or not scored cannot be counted with others.
    const unfit = comparability(run, run);
    if (unfit.length > 0) {
      leftOut.push({ runId: run.manifest.runId, reason: unfit.join("; ") });
      continue;
    }
    const group = groups.find((runs) => sameSystem(runs[0]!, run) && comparability(runs[0]!, run).length === 0);
    if (group) group.push(run);
    else groups.push([run]);
  }

  const checks = [...new Set(groups.flat().flatMap((run) => run.evaluations!.map(({ evaluator }) => evaluator.id)))];
  const tags = [...new Set(latest.cases.flatMap((c) => c.tags ?? []))].map((tag) => ({
    tag,
    cases: latest.cases.filter((c) => c.tags?.includes(tag)).length,
  }));
  const names = nameSystems(groups.map((runs) => runs[0]!.manifest.candidate));

  const systems = groups
    .map((runs, i) => describe(names[i]!, runs, checks))
    .sort((x, y) => y.runIds.length - x.runIds.length || x.name.localeCompare(y.name));
  const eligible = systems.filter((s) => s.runIds.length >= MIN_RUNS && s.answered);

  const differences: Overview["differences"] = [];
  const overlaps: Overview["overlaps"] = [];
  const incomparable: Overview["incomparable"] = [];
  const firstRun = (s: SystemOverview) => groups.find((runs) => runs[0]!.manifest.runId === s.runIds[0])![0]!;
  for (const [i, a] of eligible.entries()) {
    for (const b of eligible.slice(i + 1)) {
      const reasons = comparability(firstRun(a), firstRun(b));
      if (reasons.length > 0) {
        incomparable.push({ a: a.name, b: b.name, reasons });
        continue;
      }
      for (const check of checks) {
        const [x, y] = [a.checks[check], b.checks[check]];
        if (!x || !y || x.low === null || y.low === null) continue;
        if (x.low > y.high!) differences.push({ check, higher: a.name, lower: b.name });
        else if (y.low > x.high!) differences.push({ check, higher: b.name, lower: a.name });
        else overlaps.push({ a: a.name, b: b.name, check });
      }
    }
  }

  return {
    scenario,
    dataset,
    checks,
    tags,
    systems,
    eligible: eligible.map((s) => s.name),
    differences,
    overlaps,
    incomparable,
    leftOut,
  };
}

/** Runs are of one system when they were made by the same candidate, version and settings. */
function sameSystem(a: RunData, b: RunData): boolean {
  const [x, y] = [a.manifest.candidate, b.manifest.candidate];
  return x.id === y.id && x.version === y.version && JSON.stringify(x.config) === JSON.stringify(y.config);
}

function nameSystems(candidates: Manifest["candidate"][]): string[] {
  const named = candidates.map((c) =>
    candidates.filter((other) => other.id === c.id).length > 1 ? `${c.id} ${c.version}` : c.id,
  );
  // Two systems differing only in settings get a number, so that no two share a name.
  return named.map((name, i) => {
    const before = named.slice(0, i).filter((other) => other === name).length;
    return before === 0 ? name : `${name} (${before + 1})`;
  });
}

function describe(name: string, runs: RunData[], checks: string[]): SystemOverview {
  const summaries = runs.map((run) => summarize(run.results, run.evaluations!, run.cases));
  const spread = (slices: SliceSummary[], check: string): Spread => {
    const shares = slices.map((slice) => passRate(slice, check));
    const judged = shares.filter((share) => share.of > 0).map((share) => share.pass / share.of);
    return {
      runs: shares,
      low: judged.length === 0 ? null : Math.min(...judged),
      high: judged.length === 0 ? null : Math.max(...judged),
      unanswered: shares.some((share) => share.unanswered > 0),
    };
  };
  const byCheck = (slices: SliceSummary[]) => Object.fromEntries(checks.map((check) => [check, spread(slices, check)]));
  const tags = [...new Set(summaries.flatMap((summary) => summary.byTag.map((tag) => tag.tag)))];

  return {
    name,
    candidate: runs[0]!.manifest.candidate,
    runIds: runs.map((run) => run.manifest.runId),
    answered: summaries.every((summary) => summary.byStatus.completed.length === summary.cases),
    checks: byCheck(summaries),
    byTag: Object.fromEntries(
      tags.map((tag) => [tag, byCheck(summaries.map((summary) => summary.byTag.find((t) => t.tag === tag) ?? empty(summary)))]),
    ),
    ...(runs.length > 1 && { steadiness: Object.fromEntries(checks.map((check) => [check, steadiness(runs, check)])) }),
  };
}

function steadiness(runs: RunData[], check: string): Steadiness {
  const outcomes = new Map<string, string[]>();
  for (const run of runs) {
    for (const { caseId, evaluator, verdict } of run.evaluations!) {
      if (evaluator.id !== check || verdict.outcome === "not_applicable") continue;
      outcomes.set(caseId, [...(outcomes.get(caseId) ?? []), verdict.outcome]);
    }
  }
  const result: Steadiness = { passedEveryTime: [], failedEveryTime: [], varied: [], unanswered: [] };
  for (const [caseId, seen] of outcomes) {
    if (seen.includes("not_evaluated")) {
      result.unanswered.push(caseId);
      continue;
    }
    const passed = seen.filter((outcome) => outcome === "pass").length;
    if (passed === seen.length) result.passedEveryTime.push(caseId);
    else if (passed === 0) result.failedEveryTime.push(caseId);
    else result.varied.push({ caseId, passed, of: seen.length });
  }
  return result;
}

/** A slice with no cases, for a run in which no case carries a tag that other runs' cases do. */
function empty(summary: SliceSummary): SliceSummary {
  return { ...summary, cases: 0, evaluators: [] };
}
