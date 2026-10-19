import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationRecord } from "./artifact.ts";
import { labelBreakdowns } from "./labels.ts";

const sorted = (caseId: string, expected: string, actual: string, version = "1"): EvaluationRecord => ({
  caseId,
  evaluator: { id: "label", version },
  verdict: { outcome: expected === actual ? "pass" : "fail", label: { expected, actual } },
});

test("each label says how often it should have been given, was given, and was right", () => {
  const [breakdown, ...others] = labelBreakdowns([
    sorted("c1", "quiet", "quiet"),
    sorted("c2", "quiet", "loud"),
    sorted("c3", "quiet", "loud"),
    sorted("c4", "quiet", "quiet"),
    sorted("c5", "loud", "loud"),
    sorted("c6", "rare", "quiet"),
    sorted("c7", "loud", "never-expected"),
  ]);

  assert.equal(others.length, 0);
  assert.equal(breakdown!.cases, 7);
  assert.deepEqual(
    breakdown!.labels.map(({ label, expected, given, right, precision, recall }) => [label, expected.length, given.length, right.length, precision, recall]),
    [
      ["quiet", 4, 3, 2, 2 / 3, 2 / 4],
      ["loud", 2, 3, 1, 1 / 3, 1 / 2],
      ["rare", 1, 0, 0, null, 0],
      ["never-expected", 0, 1, 0, 0, null],
    ],
  );
  assert.deepEqual(breakdown!.mistakes, [
    { expected: "quiet", actual: "loud", caseIds: ["c2", "c3"] },
    { expected: "rare", actual: "quiet", caseIds: ["c6"] },
    { expected: "loud", actual: "never-expected", caseIds: ["c7"] },
  ]);
});

test("only verdicts that carry a label count, and two versions of a check are kept apart", () => {
  const records: EvaluationRecord[] = [
    sorted("c1", "quiet", "quiet"),
    sorted("c1", "quiet", "loud", "2"),
    { caseId: "c2", evaluator: { id: "label", version: "1" }, verdict: { outcome: "not_evaluated", detail: "the case did not complete (error)" } },
    { caseId: "c3", evaluator: { id: "label", version: "1" }, verdict: { outcome: "error", detail: "the evaluator threw: boom" } },
    { caseId: "c1", evaluator: { id: "tone", version: "1" }, verdict: { outcome: "pass" } },
  ];
  const breakdowns = labelBreakdowns(records);

  assert.deepEqual(breakdowns.map(({ evaluator, cases }) => [evaluator.version, cases]), [["1", 1], ["2", 1]]);
  assert.deepEqual(labelBreakdowns([]), []);
});
