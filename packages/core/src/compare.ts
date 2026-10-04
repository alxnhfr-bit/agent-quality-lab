/**
 * Compares two runs of the same scenario on the same dataset, case by case.
 * Pure: it takes loaded runs and returns plain data that any interface can render.
 *
 * It describes where the runs differ and calls nothing a regression: with one
 * run per side there is no telling a real change from run-to-run noise.
 */
import type { CaseResult, EvaluationRecord, JsonValue, Manifest, Verdict } from "./artifact.ts";
import { summarize, type RunSummary } from "./summary.ts";

export interface RunData {
  manifest: Manifest;
  results: readonly CaseResult[];
  /** null when the run has not been scored. */
  evaluations: readonly EvaluationRecord[] | null;
}

export interface Comparison {
  scenario: Manifest["scenario"];
  dataset: Manifest["dataset"];
  a: ComparedRun;
  b: ComparedRun;
  evaluators: EvaluatorComparison[];
  /** One entry per case, in dataset order. */
  cases: CaseComparison[];
}

export interface ComparedRun {
  runId: string;
  candidate: Manifest["candidate"];
  summary: RunSummary;
}

/** Case ids by the side on which one evaluator passed. */
export interface EvaluatorComparison {
  id: string;
  version: string;
  both: string[];
  onlyA: string[];
  onlyB: string[];
  neither: string[];
  /** A side was not applicable, or the evaluator itself failed, so there is nothing to compare. */
  undetermined: string[];
}

export type Difference = "status" | "output" | "verdicts" | "tool_calls";

export interface CaseComparison {
  caseId: string;
  a: CaseSide;
  b: CaseSide;
  /** What observably differs between the two sides. Empty when nothing does. */
  differences: Difference[];
}

export interface CaseSide {
  status: CaseResult["status"];
  /** Outcome per evaluator id. */
  verdicts: Record<string, Verdict["outcome"]>;
  toolCalls: number;
  fallback: boolean;
  durationMs: number;
}

/**
 * Why two runs cannot be compared; empty when they can. Runs are comparable
 * only if they faced the same task under the same conditions and were scored
 * the same way.
 */
export function comparability(a: RunData, b: RunData): string[] {
  const [ma, mb] = [a.manifest, b.manifest];
  if (ma.scenario.id !== mb.scenario.id) {
    return [`they are runs of different scenarios (${ma.scenario.id} and ${mb.scenario.id})`];
  }

  const reasons: string[] = [];
  if (ma.scenario.version !== mb.scenario.version) {
    reasons.push(`the scenario changed between them (version ${ma.scenario.version} and ${mb.scenario.version})`);
  }
  if (ma.dataset.name !== mb.dataset.name || ma.dataset.sha256 !== mb.dataset.sha256) {
    const describe = (d: Manifest["dataset"]) => `${d.name} ${d.sha256.slice(0, 8)}`;
    reasons.push(`they used different datasets (${describe(ma.dataset)} and ${describe(mb.dataset)})`);
  } else if (caseIds(a).join("\n") !== caseIds(b).join("\n")) {
    reasons.push("their results do not cover the same cases");
  }
  if (ma.settings.timeoutMs !== mb.settings.timeoutMs) {
    reasons.push(`they ran with different time limits (${ma.settings.timeoutMs} ms and ${mb.settings.timeoutMs} ms)`);
  }

  const unscored = (ma.runId === mb.runId ? [a] : [a, b]).flatMap((run) => {
    const problem = scoringProblem(run);
    return problem ? [`${run.manifest.runId} ${problem}: run "aql eval ${run.manifest.runId}"`] : [];
  });
  reasons.push(...unscored);
  if (unscored.length === 0) {
    const [la, lb] = [evaluatorLabels(a).join(", "), evaluatorLabels(b).join(", ")];
    if (la !== lb) {
      reasons.push(`they were scored with different evaluators (${la} and ${lb}): score both again with "aql eval"`);
    }
  }
  return reasons;
}

export function compare(a: RunData, b: RunData): Comparison {
  const reasons = comparability(a, b);
  if (reasons.length > 0) throw new Error(`the runs cannot be compared: ${reasons.join("; ")}`);

  const [sidesA, sidesB] = [sides(a), sides(b)];
  const cases = a.results.map(({ caseId }): CaseComparison => {
    const [sa, sb] = [sidesA.get(caseId)!, sidesB.get(caseId)!];
    return { caseId, a: sa.side, b: sb.side, differences: differences(sa, sb) };
  });

  const evaluators = evaluatorsOf(a).map((evaluator): EvaluatorComparison => {
    const comparison: EvaluatorComparison = { ...evaluator, both: [], onlyA: [], onlyB: [], neither: [], undetermined: [] };
    for (const c of cases) {
      comparison[bucket(c.a.verdicts[evaluator.id], c.b.verdicts[evaluator.id])].push(c.caseId);
    }
    return comparison;
  });

  return {
    scenario: a.manifest.scenario,
    dataset: a.manifest.dataset,
    a: comparedRun(a),
    b: comparedRun(b),
    evaluators,
    cases,
  };
}

function comparedRun(run: RunData): ComparedRun {
  return {
    runId: run.manifest.runId,
    candidate: run.manifest.candidate,
    summary: summarize(run.results, run.evaluations ?? []),
  };
}

type Bucket = "both" | "onlyA" | "onlyB" | "neither" | "undetermined";

function bucket(a: Verdict["outcome"] | undefined, b: Verdict["outcome"] | undefined): Bucket {
  // A case that did not complete did not pass, so it counts like a fail here.
  const settled = (outcome: Verdict["outcome"] | undefined) =>
    outcome === "pass" || outcome === "fail" || outcome === "not_evaluated";
  if (!settled(a) || !settled(b)) return "undetermined";
  if (a === "pass") return b === "pass" ? "both" : "onlyA";
  return b === "pass" ? "onlyB" : "neither";
}

interface SideDetail {
  side: CaseSide;
  result: CaseResult;
}

function sides(run: RunData): Map<string, SideDetail> {
  const details = new Map<string, SideDetail>();
  for (const result of run.results) {
    const toolCalls = result.trace.filter((event) => event.type === "tool_call").length;
    const fallback = result.trace.some((event) => event.type === "fallback");
    const side: CaseSide = { status: result.status, verdicts: {}, toolCalls, fallback, durationMs: result.durationMs };
    details.set(result.caseId, { side, result });
  }
  for (const { caseId, evaluator, verdict } of run.evaluations ?? []) {
    details.get(caseId)!.side.verdicts[evaluator.id] = verdict.outcome;
  }
  return details;
}

function differences(a: SideDetail, b: SideDetail): Difference[] {
  const found: Difference[] = [];
  if (a.side.status !== b.side.status) found.push("status");
  if (a.result.status === "completed" && b.result.status === "completed") {
    const [oa, ob] = [a.result.output, b.result.output];
    // Two abstentions are the same behaviour however the reason is worded.
    const same = oa.kind === "answer" && ob.kind === "answer" ? jsonEqual(oa.value, ob.value) : oa.kind === ob.kind;
    if (!same) found.push("output");
  }
  const ids = new Set([...Object.keys(a.side.verdicts), ...Object.keys(b.side.verdicts)]);
  if ([...ids].some((id) => a.side.verdicts[id] !== b.side.verdicts[id])) found.push("verdicts");
  if (a.side.toolCalls !== b.side.toolCalls) found.push("tool_calls");
  return found;
}

function caseIds(run: RunData): string[] {
  return run.results.map((result) => result.caseId).sort();
}

function evaluatorsOf(run: RunData): { id: string; version: string }[] {
  const seen = new Map<string, { id: string; version: string }>();
  for (const { evaluator } of run.evaluations ?? []) seen.set(`${evaluator.id}@${evaluator.version}`, evaluator);
  return [...seen.values()];
}

function evaluatorLabels(run: RunData): string[] {
  return evaluatorsOf(run)
    .map(({ id, version }) => `${id}@${version}`)
    .sort();
}

/** A scored run has exactly one verdict per case from one version of each evaluator. */
function scoringProblem(run: RunData): string | null {
  if (run.evaluations === null) return "has not been scored";
  const evaluators = evaluatorsOf(run);
  const known = new Set(run.results.map((result) => result.caseId));
  const pairs = new Set(run.evaluations.map(({ caseId, evaluator }) => `${caseId}\n${evaluator.id}`));
  const complete =
    new Set(evaluators.map(({ id }) => id)).size === evaluators.length &&
    pairs.size === run.evaluations.length &&
    run.evaluations.length === known.size * evaluators.length &&
    run.evaluations.every(({ caseId }) => known.has(caseId));
  return complete ? null : "has incomplete evaluations";
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]!))
    );
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key]!, b[key]!));
}
