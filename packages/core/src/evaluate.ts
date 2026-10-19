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
  type Manifest,
  type Verdict,
} from "./artifact.ts";
import type { Case, CompletedCase, Evaluator, Scenario } from "./types.ts";

type Completed = Extract<CaseResult, { status: "completed" }>;

/** What a run knows about the tools behind its answers. */
export interface ToolRecord {
  /** Whether the run's tool calls were recorded. Always so for a run the lab made. */
  calls: boolean;
  /** The tools the candidate could call, by name, when that is known. */
  tools?: readonly string[];
}

/** Read from a run's manifest: the scenario's tools for a run of the lab, the source's for an imported one. */
export function toolRecordOf(manifest: Manifest): ToolRecord {
  const named = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);
  if (manifest.origin) return manifest.origin.tools ? { calls: true, tools: named(manifest.origin.tools) } : { calls: false };
  return { calls: true, ...(manifest.scenario.tools && { tools: named(manifest.scenario.tools) }) };
}

export async function evaluateRun<I, O, E, S>(
  scenario: Pick<Scenario<I, O, E, S>, "outputSchema" | "evaluators">,
  cases: readonly Case<I, E, S>[],
  results: readonly CaseResult[],
  record: ToolRecord = { calls: true },
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

    const completed = result.status === "completed" ? typed(scenario.outputSchema, result, record.tools) : null;
    for (const { evaluator, label } of evaluators) {
      let verdict: Verdict;
      if (completed === null) {
        verdict = { outcome: "not_evaluated", detail: `the case did not complete (${result.status})` };
      } else if ("problem" in completed) {
        verdict = { outcome: "error", detail: completed.problem };
      } else if (evaluator.readsToolCalls && !record.calls) {
        verdict = { outcome: "not_applicable", detail: "the run did not record its tool calls" };
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
  tools: readonly string[] | undefined,
): CompletedCase<O> | { problem: string } {
  const known = { ...(durationMs !== undefined && { durationMs }), ...(tools && { tools }) };
  if (output.kind === "abstain") return { output, trace, ...known };
  const value = outputSchema.safeParse(output.value);
  return value.success
    ? { output: { kind: "answer", value: value.data }, trace, ...known }
    : { problem: "the stored answer no longer fits the scenario's output schema" };
}

/** An evaluator that throws or returns nonsense is recorded as its own failure, not the candidate's. */
async function judge<I, O, E, S>(
  evaluator: Evaluator<I, O, E, S>,
  c: Case<I, E, S>,
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
