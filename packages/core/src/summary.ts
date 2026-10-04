/**
 * Aggregates one run. Every count is a list of case ids, so any number an
 * interface shows can be traced back to the cases behind it.
 */
import type { CaseResult, EvaluationRecord } from "./artifact.ts";

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
  /** Summed over model calls that carry usage. null when none do. */
  tokens: { input: number; output: number } | null;
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
      ...summarizeSlice(slice, evaluations.filter((record) => ids.has(record.caseId))),
    };
  });
  return { ...summarizeSlice(results, evaluations), byTag };
}

function summarizeSlice(results: readonly CaseResult[], evaluations: readonly EvaluationRecord[]): SliceSummary {
  const byStatus: SliceSummary["byStatus"] = { completed: [], malformed_output: [], error: [], timeout: [] };
  const fallbacks: string[] = [];
  const toolCalls = { total: 0, failed: 0 };
  const tokens = { input: 0, output: 0 };
  let usageReported = false;

  for (const result of results) {
    byStatus[result.status].push(result.caseId);
    if (result.trace.some((event) => event.type === "fallback")) fallbacks.push(result.caseId);
    for (const event of result.trace) {
      if (event.type === "tool_call") {
        toolCalls.total += 1;
        if (event.error !== undefined) toolCalls.failed += 1;
      } else if (event.type === "model_call" && event.usage) {
        usageReported = true;
        tokens.input += event.usage.inputTokens;
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
    durationMs: durations.length === 0 ? null : { median: median(durations), max: durations.at(-1)! },
    toolCalls,
    tokens: usageReported ? tokens : null,
  };
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 1000) / 1000;
}
