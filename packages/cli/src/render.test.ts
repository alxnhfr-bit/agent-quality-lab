import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compare,
  summarize,
  type CaseResult,
  type DatasetCase,
  type EvaluationRecord,
  type Manifest,
  type RunData,
} from "@agent-quality-lab/core";
import { renderComparison, renderRun } from "./render.ts";

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
  { caseId: "b", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "not_evaluated", detail: "timeout" } },
  { caseId: "b", evaluator: { id: "style", version: "2" }, verdict: { outcome: "not_evaluated", detail: "timeout" } },
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
      // style does not apply to case a, so it is judged on two cases, not three.
      "style        2        0/2   0     1    1                1",
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

test("a run in which nothing completed still shows its evaluators, with nothing passed", () => {
  const failed = results.slice(1, 2);
  const skipped = evaluations.filter((record) => record.caseId === "b");
  const text = renderRun({ manifest, results: failed, evaluations: skipped, summary: summarize(failed, skipped) });
  assert.match(text, /correctness  1        0\/1   0     0    0                1/);
  assert.doesNotMatch(text, /\nfailed\n/);
});

test("a run without evaluation records says so instead of showing an empty table", () => {
  const text = renderRun({ manifest, results, evaluations: [], summary: summarize(results, []) });
  assert.match(text, /no evaluations: the run has no cases or the scenario has no evaluators/);
});

// --- Comparison --------------------------------------------------------------

const cases: DatasetCase[] = ["a", "b", "c"].map((id) => ({ id, input: null }));

const other: RunData = {
  cases,
  manifest: {
    ...manifest,
    runId: "2026-10-04T10-00-00Z_demo_agent",
    candidate: { id: "agent", version: "3", config: null, deterministic: false },
  },
  results: [
    {
      caseId: "a",
      status: "completed",
      output: { kind: "answer", value: 2 },
      durationMs: 12,
      trace: [
        { seq: 0, source: "reported", type: "model_call", model: "m", usage: { inputTokens: 30, outputTokens: 4 } },
        { seq: 1, source: "observed", type: "tool_call", name: "lookup", args: null, error: "down" },
        { seq: 2, source: "reported", type: "fallback", from: "lookup", to: "guess", reason: "down" },
        { seq: 3, source: "observed", type: "tool_call", name: "lookup", args: null, result: 2 },
      ],
    },
    { caseId: "b", status: "completed", output: { kind: "abstain", reason: "unsure" }, durationMs: 8, trace: [] },
    { caseId: "c", status: "completed", output: { kind: "answer", value: 7 }, durationMs: 3, trace: [] },
  ],
  evaluations: [
    { caseId: "a", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "pass" } },
    { caseId: "a", evaluator: { id: "style", version: "2" }, verdict: { outcome: "pass" } },
    { caseId: "b", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "pass" } },
    { caseId: "b", evaluator: { id: "style", version: "2" }, verdict: { outcome: "fail", detail: "terse" } },
    { caseId: "c", evaluator: { id: "correctness", version: "1" }, verdict: { outcome: "fail", detail: "expected 6" } },
    { caseId: "c", evaluator: { id: "style", version: "2" }, verdict: { outcome: "error", detail: "the evaluator threw: boom" } },
  ],
};

test("a comparison shows both runs side by side, then where they differ", () => {
  const first: RunData = { manifest, cases, results, evaluations };
  assert.equal(
    renderComparison(compare(first, other), first, other),
    [
      "demo v2 · dataset dev · 3 cases",
      "",
      "A  echo v1   run 2026-10-04T09-00-00Z_demo_echo",
      "B  agent v3  run 2026-10-04T10-00-00Z_demo_agent",
      "",
      "note: not deterministic: agent. Each run is one sample, so a difference on a single case may be noise",
      "",
      "                  A              B",
      "completed         2/3            3/3",
      "malformed output  0              0",
      "error             0              0",
      "timeout           1              0",
      "fallbacks         0              1",
      "correctness pass  1/3            2/3",
      "style pass        0/2            1/3",
      "median duration   3.00 ms        8.00 ms",
      "max duration      20 ms          12 ms",
      "tool calls        1 (0 failed)   2 (1 failed)",
      "tokens            none reported  30 in, 4 out",
      "",
      "by evaluator",
      "  correctness  passes only in B (1)    b",
      // In A, style did not apply to case a and the evaluator failed on case c.
      "  style        cannot be compared (2)  a, c",
      "",
      "cases that differ in status or verdicts (2 of 3)",
      "  a  A  answer 2, 1 tool call",
      "     B  answer 2, 2 tool calls, fallback",
      "  b  A  timeout after 20 ms",
      "     B  abstain, 0 tool calls, fails style",
    ].join("\n"),
  );
});

test("two runs that behave alike are reported as such", () => {
  const settled = evaluations.filter((record) => record.evaluator.id === "correctness");
  const first: RunData = { manifest, cases, results, evaluations: settled };
  const text = renderComparison(compare(first, first), first, first);
  assert.match(text, /\nevery evaluator passes on the same cases in both runs\n/);
  assert.match(text, /\nno case differs in status, output, verdicts or tool calls$/);
});

// --- By tag ------------------------------------------------------------------

const tagged: DatasetCase[] = [
  { id: "a", input: null, tags: ["easy"] },
  { id: "b", input: null, tags: ["easy", "slow"] },
  { id: "c", input: null },
];

test("a run with tagged cases also shows its counts per tag", () => {
  const text = renderRun({ manifest, results, evaluations, summary: summarize(results, evaluations, tagged) });
  assert.ok(
    text.includes(
      [
        "",
        "tag   cases  completed  correctness pass  style pass",
        "easy  2      1/2        1/2               0/1",
        "slow  1      0/1        0/1               0/1",
        "",
      ].join("\n"),
    ),
    text,
  );
});

test("a comparison shows both sides per tag", () => {
  const first: RunData = { manifest, cases: tagged, results, evaluations };
  const second: RunData = { ...other, cases: tagged };
  const text = renderComparison(compare(first, second), first, second);
  assert.ok(
    text.includes(
      [
        "",
        "tag   cases  completed A · B  correctness pass A · B  style pass A · B",
        "easy  2      1/2 · 2/2        1/2 · 2/2               0/1 · 1/2",
        "slow  1      0/1 · 1/1        0/1 · 1/1               0/1 · 0/1",
        "",
      ].join("\n"),
    ),
    text,
  );
});

test("cases that differ only in wording or lookups are named, not spelled out", () => {
  const reworded: RunData = {
    ...other,
    cases,
    results: results.map((result) =>
      result.status === "completed" ? { ...result, output: { kind: "answer", value: "worded differently" } } : result,
    ),
    evaluations,
  };
  const first: RunData = { manifest, cases, results, evaluations };
  const text = renderComparison(compare(first, reworded), first, reworded);
  assert.match(text, /\nno case differs in status or verdicts\n/);
  assert.ok(text.endsWith("\nsame verdicts, different output or tool calls (2)\n  a, c"), text);
});

test("a check that applies to no case in a tag shows as not applicable, not as zero passes", () => {
  const onlyStyle = evaluations.filter((record) => record.evaluator.id === "style" && record.caseId === "a");
  const one = results.slice(0, 1);
  const text = renderRun({
    manifest,
    results: one,
    evaluations: onlyStyle,
    summary: summarize(one, onlyStyle, [{ id: "a", tags: ["easy"] }]),
  });
  assert.match(text, /\nstyle      2        n\/a   0     1    0                0\n/);
  assert.match(text, /\neasy  1      1\/1        n\/a$/);
});
