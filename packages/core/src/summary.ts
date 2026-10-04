/**
 * Aggregates one run. Every count is a list of case ids, so any number an
 * interface shows can be traced back to the cases behind it.
 */
import type { CaseResult, EvaluationRecord } from "./artifact.ts";

export interface RunSummary {
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

/** Case ids by verdict, for one version of one evaluator. */
export interface EvaluatorSummary {
  id: string;
  version: string;
  pass: string[];
  fail: string[];
  notApplicable: string[];
  /** The evaluator itself failed on these cases. */
  error: string[];
  /** Cases the evaluator never saw because they did not complete. They are not passes. */
  notEvaluated: string[];
}

const BUCKET = {
  pass: "pass",
  fail: "fail",
  not_applicable: "notApplicable",
  error: "error",
} as const;

export function summarize(results: readonly CaseResult[], evaluations: readonly EvaluationRecord[]): RunSummary {
  const byStatus: RunSummary["byStatus"] = { completed: [], malformed_output: [], error: [], timeout: [] };
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
  for (const summary of evaluators.values()) {
    const seen = new Set([...summary.pass, ...summary.fail, ...summary.notApplicable, ...summary.error]);
    summary.notEvaluated = results.map((result) => result.caseId).filter((caseId) => !seen.has(caseId));
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
