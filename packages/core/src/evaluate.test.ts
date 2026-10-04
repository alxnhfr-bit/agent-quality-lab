import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { CaseResult } from "./artifact.ts";
import { evaluateRun } from "./evaluate.ts";
import type { Case, Evaluator } from "./types.ts";

type In = { n: number };
type Out = { n: number };

const outputSchema = z.strictObject({ n: z.number() });
const cases: Case<In, Out>[] = [
  { id: "a", input: { n: 1 }, expected: { n: 2 } },
  { id: "b", input: { n: 2 }, expected: { n: 4 } },
  { id: "c", input: { n: 3 }, expected: { n: 6 } },
];

const answered = (caseId: string, value: unknown): CaseResult => ({
  caseId,
  status: "completed",
  output: { kind: "answer", value: value as never },
  durationMs: 1,
  trace: [],
});
const timedOut = (caseId: string): CaseResult => ({ caseId, status: "timeout", timeoutMs: 20, durationMs: 20, trace: [] });

const doubles: Evaluator<In, Out, Out> = {
  id: "doubles",
  version: "1",
  evaluate: (c, { output }) =>
    output.kind === "answer" && output.value.n === c.expected?.n
      ? { outcome: "pass" }
      : { outcome: "fail", detail: `expected ${c.expected?.n}` },
};
const quick: Evaluator<In, Out, Out> = {
  id: "quick",
  version: "2",
  evaluate: async (_c, { durationMs }) => ({ outcome: durationMs < 10 ? "pass" : "fail", value: durationMs }),
};

test("there is one record per case and evaluator, and only completed cases are judged", async () => {
  const notEvaluated = { outcome: "not_evaluated", detail: "the case did not complete (timeout)" };
  const records = await evaluateRun({ outputSchema, evaluators: [doubles, quick] }, cases, [
    answered("a", { n: 2 }),
    timedOut("b"),
    answered("c", { n: 7 }),
  ]);
  assert.deepEqual(records, [
    { caseId: "a", evaluator: { id: "doubles", version: "1" }, verdict: { outcome: "pass" } },
    { caseId: "a", evaluator: { id: "quick", version: "2" }, verdict: { outcome: "pass", value: 1 } },
    { caseId: "b", evaluator: { id: "doubles", version: "1" }, verdict: notEvaluated },
    { caseId: "b", evaluator: { id: "quick", version: "2" }, verdict: notEvaluated },
    { caseId: "c", evaluator: { id: "doubles", version: "1" }, verdict: { outcome: "fail", detail: "expected 6" } },
    { caseId: "c", evaluator: { id: "quick", version: "2" }, verdict: { outcome: "pass", value: 1 } },
  ]);
});

test("an evaluator that throws is recorded as its own error and does not stop the others", async () => {
  const broken: Evaluator<In, Out, Out> = {
    id: "broken",
    version: "1",
    evaluate: () => {
      throw new Error("boom");
    },
  };
  const records = await evaluateRun({ outputSchema, evaluators: [broken, doubles] }, cases, [answered("a", { n: 2 })]);
  assert.deepEqual(
    records.map((record) => record.verdict),
    [{ outcome: "error", detail: "the evaluator threw: boom" }, { outcome: "pass" }],
  );
});

test("a verdict an evaluator may not give is an evaluator error, never a pass", async () => {
  const invalid = [
    { outcome: "great" },
    { outcome: "not_applicable" },
    { outcome: "not_evaluated", detail: "skipped" },
    undefined,
  ];
  for (const returned of invalid) {
    const sloppy: Evaluator<In, Out, Out> = { id: "sloppy", version: "1", evaluate: () => returned as never };
    const [record] = await evaluateRun({ outputSchema, evaluators: [sloppy] }, cases, [answered("a", { n: 2 })]);
    assert.deepEqual(record?.verdict, { outcome: "error", detail: "the evaluator returned an invalid verdict" });
  }
});

test("a stored answer that no longer fits the output schema is an evaluator error, not a fail", async () => {
  const records = await evaluateRun({ outputSchema, evaluators: [doubles] }, cases, [answered("a", { n: "two" })]);
  assert.deepEqual(records, [
    {
      caseId: "a",
      evaluator: { id: "doubles", version: "1" },
      verdict: { outcome: "error", detail: "the stored answer no longer fits the scenario's output schema" },
    },
  ]);
});

test("an abstention reaches the evaluators as it is", async () => {
  const abstained: CaseResult = {
    caseId: "a",
    status: "completed",
    output: { kind: "abstain", reason: "cannot tell" },
    durationMs: 1,
    trace: [],
  };
  const [record] = await evaluateRun({ outputSchema, evaluators: [doubles] }, cases, [abstained]);
  assert.deepEqual(record?.verdict, { outcome: "fail", detail: "expected 2" });
});

test("mislabelled evaluators and results for unknown cases are refused", async () => {
  const run = (evaluators: Evaluator<In, Out, Out>[], results: CaseResult[]) =>
    evaluateRun({ outputSchema, evaluators }, cases, results);

  await assert.rejects(run([doubles, { ...quick, id: "doubles" }], []), /unique/);
  await assert.rejects(run([{ ...doubles, id: "not a slug" }], []));
  await assert.rejects(run([doubles], [answered("z", { n: 1 })]), /case "z", which is not in the dataset/);
});
