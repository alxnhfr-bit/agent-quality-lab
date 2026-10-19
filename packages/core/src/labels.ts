/**
 * For checks that sort cases into labels: which labels were mistaken for
 * which. A share of right answers hides the shape of the mistakes; a system
 * that files everything under the most common label can still score well.
 *
 * Counting only, from the label each verdict recorded. Cases a check did not
 * decide (not completed, not applicable, the check failed) carry no label and
 * are left out here; they still count against the candidate in the pass counts.
 */
import type { EvaluationRecord } from "./artifact.ts";

export interface LabelBreakdown {
  evaluator: { id: string; version: string };
  /** Cases the check decided and labelled. */
  cases: number;
  /** Labels that should have been given most often come first. */
  labels: LabelCount[];
  /** Every way a case was mislabelled, the most frequent first. */
  mistakes: { expected: string; actual: string; caseIds: string[] }[];
}

export interface LabelCount {
  label: string;
  /** Cases that should have had this label. */
  expected: string[];
  /** Cases that were given it. */
  given: string[];
  /** Cases that should have had it and were given it. */
  right: string[];
  /** Of the cases given this label, the share that should have had it. null when none was given it. */
  precision: number | null;
  /** Of the cases that should have had this label, the share that were given it. null when none should have. */
  recall: number | null;
}

/** One breakdown for each version of each check that recorded labels. */
export function labelBreakdowns(evaluations: readonly EvaluationRecord[]): LabelBreakdown[] {
  const byEvaluator = new Map<string, EvaluationRecord[]>();
  for (const record of evaluations) {
    if (!("label" in record.verdict) || !record.verdict.label) continue;
    const key = `${record.evaluator.id}@${record.evaluator.version}`;
    byEvaluator.set(key, [...(byEvaluator.get(key) ?? []), record]);
  }
  return [...byEvaluator.values()].map(breakdown);
}

function breakdown(records: EvaluationRecord[]): LabelBreakdown {
  const sorted = records.map(({ caseId, verdict }) => {
    const { expected, actual } = (verdict as { label: { expected: string; actual: string } }).label;
    return { caseId, expected, actual };
  });

  const counts = new Map<string, LabelCount>();
  const count = (label: string) => {
    if (!counts.has(label)) counts.set(label, { label, expected: [], given: [], right: [], precision: null, recall: null });
    return counts.get(label)!;
  };
  const mistakes = new Map<string, LabelBreakdown["mistakes"][number]>();
  for (const { caseId, expected, actual } of sorted) {
    count(expected).expected.push(caseId);
    count(actual).given.push(caseId);
    if (expected === actual) {
      count(expected).right.push(caseId);
      continue;
    }
    const key = `${expected}\n${actual}`;
    if (!mistakes.has(key)) mistakes.set(key, { expected, actual, caseIds: [] });
    mistakes.get(key)!.caseIds.push(caseId);
  }

  const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);
  const labels = [...counts.values()]
    .map((c) => ({ ...c, precision: share(c.right.length, c.given.length), recall: share(c.right.length, c.expected.length) }))
    // Stable: labels as common as each other keep the order they first appeared in.
    .sort((x, y) => y.expected.length - x.expected.length || y.given.length - x.given.length);

  return {
    evaluator: records[0]!.evaluator,
    cases: sorted.length,
    labels,
    mistakes: [...mistakes.values()].sort((x, y) => y.caseIds.length - x.caseIds.length),
  };
}
