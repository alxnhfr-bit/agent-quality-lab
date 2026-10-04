import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize, type CaseResult, type EvaluationRecord, type Manifest } from "@agent-quality-lab/core";
import { renderRun } from "./render.ts";

const manifest: Manifest = {
  schemaVersion: 1,
  runId: "2026-10-04T09-00-00Z_demo_echo",
  scenario: { id: "demo", version: "2" },
  dataset: { name: "dev", sha256: "a".repeat(64), caseCount: 3 },
  candidate: { id: "echo", version: "1", config: null, deterministic: true },
  settings: { timeoutMs: 20 },
  startedAt: "2026-10-04T09:00:00.000Z",
  finishedAt: "2026-10-04T09:00:02.000Z",
  environment: { node: "v24.0.0", platform: "test", git: null },
};

const results: CaseResult[] = [
  {
    caseId: "a",
    status: "completed",
    output: { kind: "answer", value: 2 },
    durationMs: 1.5,
    trace: [{ seq: 0, source: "observed", type: "tool_call", name: "lookup", args: null, result: 2 }],
  },
  { caseId: "b", status: "timeout", timeoutMs: 20, durationMs: 20, trace: [] },
  { caseId: "c", status: "completed", output: { kind: "answer", value: 7 }, durationMs: 3, trace: [] },
];

const evaluations: EvaluationRecord[] = [
  { caseId: "a", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "pass" } },
  { caseId: "a", evaluator: { id: "style", version: "2" }, verdict: { outcome: "not_applicable", detail: "no text" } },
  { caseId: "c", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "fail", detail: "expected 6" } },
  { caseId: "c", evaluator: { id: "style", version: "2" }, verdict: { outcome: "error", detail: "the evaluator threw: boom" } },
];

test("a run is shown with its counts and every case behind a failure", () => {
  const text = renderRun({ manifest, results, evaluations, summary: summarize(results, evaluations) });
  assert.equal(
    text,
    [
      "demo v2 · echo v1 · dataset dev · 3 cases",
      "run 2026-10-04T09-00-00Z_demo_echo",
      "",
      "execution   2 completed, 0 malformed output, 0 error, 1 timeout",
      "fallbacks   none",
      "duration    median 3.00 ms, max 20 ms",
      "tool calls  1, of which 0 failed",
      "",
      "evaluator    version  pass  fail  n/a  evaluator error  not evaluated",
      "correctness  1        1/3   1     0    0                1",
      "style        2        0/3   0     1    1                1",
      "",
      "not completed",
      "  b  timeout after 20 ms",
      "",
      "failed",
      "  c  correctness              expected 6",
      "  c  style (evaluator error)  the evaluator threw: boom",
    ].join("\n"),
  );
});

test("notes come before the numbers, including that a candidate is not deterministic", () => {
  const sampled = { ...manifest, candidate: { ...manifest.candidate, deterministic: false } };
  const lines = renderRun({
    manifest: sampled,
    results,
    evaluations,
    summary: summarize(results, evaluations),
    notes: ["scored later"],
  }).split("\n");
  assert.deepEqual(lines.slice(3, 6), [
    "note: scored later",
    "note: this candidate is not deterministic, so this run is one sample of its behaviour",
    "",
  ]);
});

test("a run in which nothing completed says so instead of showing an empty table", () => {
  const failed = results.slice(1, 2);
  const text = renderRun({ manifest, results: failed, evaluations: [], summary: summarize(failed, []) });
  assert.match(text, /no evaluations: either no case completed or the scenario has no evaluators/);
  assert.doesNotMatch(text, /\nfailed\n/);
});
