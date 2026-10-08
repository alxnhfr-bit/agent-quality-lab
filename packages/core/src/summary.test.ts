import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseResult, EvaluationRecord } from "./artifact.ts";
import { passRate, summarize } from "./summary.ts";

const results: CaseResult[] = [
  {
    caseId: "a",
    status: "completed",
    output: { kind: "answer", value: 1 },
    durationMs: 4,
    trace: [
      { seq: 0, source: "reported", type: "model_call", model: "m", usage: { inputTokens: 10, outputTokens: 2 } },
      { seq: 1, source: "observed", type: "tool_call", name: "lookup", args: null, result: 1 },
    ],
  },
  {
    caseId: "b",
    status: "completed",
    output: { kind: "abstain", reason: "x" },
    durationMs: 2,
    trace: [
      { seq: 0, source: "reported", type: "model_call", model: "m", usage: { inputTokens: 5, outputTokens: 1 } },
      { seq: 1, source: "observed", type: "tool_call", name: "lookup", args: null, error: "down" },
      { seq: 2, source: "reported", type: "fallback", from: "lookup", to: "guess", reason: "down" },
    ],
  },
  { caseId: "c", status: "timeout", timeoutMs: 20, durationMs: 20, trace: [] },
  { caseId: "d", status: "error", error: { message: "boom" }, durationMs: 1, trace: [] },
];

const record = (caseId: string, id: string, verdict: EvaluationRecord["verdict"]): EvaluationRecord => ({
  caseId,
  evaluator: { id, version: "1" },
  verdict,
});

const skipped: EvaluationRecord["verdict"] = { outcome: "not_evaluated", detail: "the case did not complete" };

test("every count is the list of cases behind it", () => {
  const summary = summarize(results, [
    record("a", "correctness", { outcome: "pass" }),
    record("a", "style", { outcome: "not_applicable", detail: "no text" }),
    record("b", "correctness", { outcome: "fail" }),
    record("b", "style", { outcome: "error", detail: "threw" }),
    ...["c", "d"].flatMap((caseId) => [record(caseId, "correctness", skipped), record(caseId, "style", skipped)]),
  ]);
  assert.deepEqual(summary, {
    cases: 4,
    byStatus: { completed: ["a", "b"], malformed_output: [], error: ["d"], timeout: ["c"] },
    fallbacks: ["b"],
    evaluators: [
      { id: "correctness", version: "1", pass: ["a"], fail: ["b"], notApplicable: [], error: [], notEvaluated: ["c", "d"] },
      { id: "style", version: "1", pass: [], fail: [], notApplicable: ["a"], error: ["b"], notEvaluated: ["c", "d"] },
    ],
    durationMs: { median: 3, max: 20 },
    toolCalls: { total: 2, failed: 1 },
    modelCalls: 2,
    tokens: { input: 15, output: 3 },
    cost: null,
    byTag: [],
  });
});

test("an evaluator is listed even when it judged no case at all", () => {
  const failed = results.slice(2);
  const evaluations = failed.map((result) => record(result.caseId, "correctness", skipped));
  assert.deepEqual(summarize(failed, evaluations).evaluators, [
    { id: "correctness", version: "1", pass: [], fail: [], notApplicable: [], error: [], notEvaluated: ["c", "d"] },
  ]);
});

test("two versions of an evaluator are kept apart", () => {
  const evaluations = [
    record("a", "correctness", { outcome: "pass" }),
    { ...record("b", "correctness", { outcome: "pass" }), evaluator: { id: "correctness", version: "2" } },
  ];
  assert.deepEqual(
    summarize(results, evaluations).evaluators.map((e) => [e.version, e.pass]),
    [
      ["1", ["a"]],
      ["2", ["b"]],
    ],
  );
});

test("nothing is invented for what was not measured", () => {
  assert.deepEqual(summarize([], []), {
    cases: 0,
    byStatus: { completed: [], malformed_output: [], error: [], timeout: [] },
    fallbacks: [],
    evaluators: [],
    durationMs: null,
    toolCalls: { total: 0, failed: 0 },
    modelCalls: 0,
    tokens: null,
    cost: null,
    byTag: [],
  });
  assert.equal(summarize(results.slice(2), []).tokens, null);
});

test("the cases carrying a tag get the same counts as the whole run", () => {
  const evaluations = [
    record("a", "correctness", { outcome: "pass" }),
    record("b", "correctness", { outcome: "fail" }),
    record("c", "correctness", skipped),
    record("d", "correctness", skipped),
  ];
  const cases = [
    { id: "a", tags: ["easy"] },
    { id: "b", tags: ["easy", "tool-failure"] },
    { id: "c", tags: ["tool-failure"] },
    { id: "d" },
  ];
  const { byTag } = summarize(results, evaluations, cases);

  assert.deepEqual(
    byTag.map((tag) => [tag.tag, tag.caseIds]),
    [
      ["easy", ["a", "b"]],
      ["tool-failure", ["b", "c"]],
    ],
  );
  const failures = byTag[1]!;
  assert.equal(failures.cases, 2);
  assert.deepEqual(failures.byStatus, { completed: ["b"], malformed_output: [], error: [], timeout: ["c"] });
  assert.deepEqual(failures.fallbacks, ["b"]);
  assert.deepEqual(failures.toolCalls, { total: 1, failed: 1 });
  assert.deepEqual(failures.evaluators, [
    { id: "correctness", version: "1", pass: [], fail: ["b"], notApplicable: [], error: [], notEvaluated: ["c"] },
  ]);
});

test("a run whose cases carry no tags has no breakdown", () => {
  assert.deepEqual(summarize(results, [], [{ id: "a" }, { id: "b" }]).byTag, []);
});

test("a pass count is out of the cases the evaluator applies to", () => {
  const summary = summarize(results, [
    record("a", "style", { outcome: "pass" }),
    record("b", "style", { outcome: "not_applicable", detail: "no text" }),
    record("c", "style", skipped),
    record("d", "style", { outcome: "error", detail: "threw" }),
  ]);
  // Not applicable is left out. Not completed and an evaluator error are not passes, and still count.
  assert.deepEqual(passRate(summary, "style"), { pass: 1, of: 3 });
  assert.deepEqual(passRate(summary, "unknown"), { pass: 0, of: 0 });
});

test("with prices, a summary says what the model calls cost in total and per case", () => {
  const prices = { currency: "USD" as const, asOf: "2026-09-25", perMillionTokens: { m: { input: 1000, output: 10000 } } };
  // Case a: 10 in, 2 out = 0.01 + 0.02. Case b: 5 in, 1 out = 0.005 + 0.01. Cases c and d call no model.
  assert.deepEqual(summarize(results, [], [], prices).cost, { total: 0.045, medianPerCase: 0.0075, unpricedModelCalls: 0 });
  assert.deepEqual(summarize(results, [], [], { ...prices, perMillionTokens: {} }).cost, {
    total: 0,
    medianPerCase: 0,
    unpricedModelCalls: 2,
  });
});
