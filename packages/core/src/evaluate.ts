/**
 * Scores the results of a run. Kept apart from execution so a run can be
 * re-scored later without running the candidate again.
 *
 * There is one record per case and evaluator. Only completed cases are judged:
 * a case that errored, timed out or returned something malformed is never shown
 * to an evaluator and is recorded as not_evaluated, so no evaluator can turn it
 * into a pass or leave it out of the count.
 */
import {
  evaluationRecordSchema,
  judgmentSchema,
  type CaseResult,
  type EvaluationRecord,
  type Verdict,
} from "./artifact.ts";
import type { Case, CompletedCase, Evaluator, Scenario } from "./types.ts";

type Completed = Extract<CaseResult, { status: "completed" }>;

export async function evaluateRun<I, O, E>(
  scenario: Pick<Scenario<I, O, E>, "outputSchema" | "evaluators">,
  cases: readonly Case<I, E>[],
  results: readonly CaseResult[],
): Promise<EvaluationRecord[]> {
  const evaluators = scenario.evaluators.map((evaluator) => ({
    evaluator,
    // Checked before anything is judged, so a mislabelled evaluator fails fast.
    label: evaluationRecordSchema.shape.evaluator.parse({ id: evaluator.id, version: evaluator.version }),
  }));
  if (new Set(evaluators.map(({ label }) => label.id)).size !== evaluators.length) {
    throw new Error("evaluator ids must be unique within a scenario");
  }

  const casesById = new Map(cases.map((c) => [c.id, c]));
  const records: EvaluationRecord[] = [];
  for (const result of results) {
    const c = casesById.get(result.caseId);
    if (!c) throw new Error(`there is a result for case "${result.caseId}", which is not in the dataset`);

    const completed = result.status === "completed" ? typed(scenario.outputSchema, result) : null;
    for (const { evaluator, label } of evaluators) {
      let verdict: Verdict;
      if (completed === null) {
        verdict = { outcome: "not_evaluated", detail: `the case did not complete (${result.status})` };
      } else if ("problem" in completed) {
        verdict = { outcome: "error", detail: completed.problem };
      } else {
        verdict = await judge(evaluator, c, completed);
      }
      records.push({ caseId: c.id, evaluator: label, verdict });
    }
  }
  return records;
}

/** A stored output is plain JSON; evaluators get it as the scenario's output type. */
function typed<O>(
  outputSchema: Scenario<unknown, O, unknown>["outputSchema"],
  { output, trace, durationMs }: Completed,
): CompletedCase<O> | { problem: string } {
  if (output.kind === "abstain") return { output, trace, durationMs };
  const value = outputSchema.safeParse(output.value);
  return value.success
    ? { output: { kind: "answer", value: value.data }, trace, durationMs }
    : { problem: "the stored answer no longer fits the scenario's output schema" };
}

/** An evaluator that throws or returns nonsense is recorded as its own failure, not the candidate's. */
async function judge<I, O, E>(
  evaluator: Evaluator<I, O, E>,
  c: Case<I, E>,
  completed: CompletedCase<O>,
): Promise<Verdict> {
  try {
    const judgment = judgmentSchema.safeParse(await evaluator.evaluate(c, completed));
    return judgment.success
      ? judgment.data
      : { outcome: "error", detail: "the evaluator returned an invalid verdict" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "error", detail: `the evaluator threw: ${message}` };
  }
}
