/**
 * Aggregates one run. Every count is a list of case ids, so any number an
 * interface shows can be traced back to the cases behind it.
 */
import type { CaseResult, EvaluationRecord, Prices } from "./artifact.ts";
import { costOf } from "./cost.ts";

/** The counts for one set of cases: a whole run, or the cases that carry one tag. */
export interface SliceSummary {
  cases: number;
  /** Case ids by how execution ended. */
  byStatus: Record<CaseResult["status"], string[]>;
  /** Cases whose trace contains a fallback. */
  fallbacks: string[];
  evaluators: EvaluatorSummary[];
  /** null when the run has no cases. */
  durationMs: { median: number; max: number } | null;
  toolCalls: { total: number; failed: number };
  modelCalls: number;
  /** Summed over model calls that carry usage. null when none do. */
  tokens: { input: number; output: number } | null;
  /**
   * What the model calls cost at the prices recorded with the run. null when
   * the run recorded no prices. Calls that could not be priced are counted, not guessed.
   */
  cost: { total: number; medianPerCase: number; unpricedModelCalls: number } | null;
}

export interface RunSummary extends SliceSummary {
  /** The same counts for the cases carrying each tag, in the order the tags first appear. */
  byTag: TagSummary[];
}

export interface TagSummary extends SliceSummary {
  tag: string;
  caseIds: string[];
}

/** Case ids by verdict, for one version of one evaluator. */
export interface EvaluatorSummary {
  id: string;
  version: string;
  pass: string[];
  fail: string[];
  notApplicable: string[];
  /** The evaluator itself failed on these cases. */
  error: string[];
  /** Cases without a judgment, because they did not complete. They are not passes. */
  notEvaluated: string[];
}

/**
 * How many cases an evaluator passed, out of those it applies to. A case the
 * evaluator calls not applicable is left out; one that did not complete, or on
 * which the evaluator itself failed, still counts.
 */
export function passRate(slice: SliceSummary, evaluatorId: string): { pass: number; of: number } {
  const e = slice.evaluators.find((evaluator) => evaluator.id === evaluatorId);
  if (!e) return { pass: 0, of: 0 };
  return { pass: e.pass.length, of: e.pass.length + e.fail.length + e.error.length + e.notEvaluated.length };
}

const BUCKET = {
  pass: "pass",
  fail: "fail",
  not_applicable: "notApplicable",
  error: "error",
  not_evaluated: "notEvaluated",
} as const;

export function summarize(
  results: readonly CaseResult[],
  evaluations: readonly EvaluationRecord[],
  cases: readonly { id: string; tags?: string[] | undefined }[] = [],
  prices?: Prices,
): RunSummary {
  const tagged = new Map<string, Set<string>>();
  for (const c of cases) {
    for (const tag of c.tags ?? []) {
      if (!tagged.has(tag)) tagged.set(tag, new Set());
      tagged.get(tag)!.add(c.id);
    }
  }
  const byTag = [...tagged].map(([tag, ids]): TagSummary => {
    const slice = results.filter((result) => ids.has(result.caseId));
    return {
      tag,
      caseIds: slice.map((result) => result.caseId),
      ...summarizeSlice(slice, evaluations.filter((record) => ids.has(record.caseId)), prices),
    };
  });
  return { ...summarizeSlice(results, evaluations, prices), byTag };
}

function summarizeSlice(
  results: readonly CaseResult[],
  evaluations: readonly EvaluationRecord[],
  prices: Prices | undefined,
): SliceSummary {
  const byStatus: SliceSummary["byStatus"] = { completed: [], malformed_output: [], error: [], timeout: [] };
  const fallbacks: string[] = [];
  const toolCalls = { total: 0, failed: 0 };
  let modelCalls = 0;
  const tokens = { input: 0, output: 0 };
  let usageReported = false;

  for (const result of results) {
    byStatus[result.status].push(result.caseId);
    if (result.trace.some((event) => event.type === "fallback")) fallbacks.push(result.caseId);
    for (const event of result.trace) {
      if (event.type === "tool_call") {
        toolCalls.total += 1;
        if (event.error !== undefined) toolCalls.failed += 1;
      } else if (event.type === "model_call") {
        modelCalls += 1;
        if (!event.usage) continue;
        usageReported = true;
        // Everything the model read counts as input here, cached or not; the cost keeps them apart.
        tokens.input +=
          event.usage.inputTokens + (event.usage.cacheReadTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0);
        tokens.output += event.usage.outputTokens;
      }
    }
  }

  const evaluators = new Map<string, EvaluatorSummary>();
  for (const { caseId, evaluator, verdict } of evaluations) {
    const key = `${evaluator.id}@${evaluator.version}`;
    if (!evaluators.has(key)) {
      evaluators.set(key, { ...evaluator, pass: [], fail: [], notApplicable: [], error: [], notEvaluated: [] });
    }
    evaluators.get(key)![BUCKET[verdict.outcome]].push(caseId);
  }

  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  return {
    cases: results.length,
    byStatus,
    fallbacks,
    evaluators: [...evaluators.values()],
    durationMs:
      durations.length === 0
        ? null
        : { median: Math.round(median(durations) * 1000) / 1000, max: durations.at(-1)! },
    toolCalls,
    modelCalls,
    tokens: usageReported ? tokens : null,
    cost: prices ? costSummary(results, prices) : null,
  };
}

function costSummary(results: readonly CaseResult[], prices: Prices): NonNullable<SliceSummary["cost"]> {
  const perCase = results.map((result) => costOf(result.trace, prices));
  const totals = perCase.map((cost) => cost.total).sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    total: round(totals.reduce((sum, value) => sum + value, 0)),
    medianPerCase: totals.length === 0 ? 0 : round(median(totals)),
    unpricedModelCalls: perCase.reduce((sum, cost) => sum + cost.unpriced, 0),
  };
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
