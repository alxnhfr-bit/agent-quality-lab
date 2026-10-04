import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseResult, EvaluationRecord, JsonValue, Manifest, Verdict } from "./artifact.ts";
import { comparability, compare, type RunData } from "./compare.ts";

type Outcome = Verdict["outcome"];

function manifest(candidateId: string, overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    runId: `2026-10-04T09-00-00Z_demo_${candidateId}`,
    scenario: { id: "demo", version: "1" },
    dataset: { name: "dev", sha256: "a".repeat(64), caseCount: 6 },
    candidate: { id: candidateId, version: "1", config: null, deterministic: true },
    settings: { timeoutMs: 20 },
    startedAt: "2026-10-04T09:00:00.000Z",
    finishedAt: "2026-10-04T09:00:02.000Z",
    environment: { node: "v24.0.0", platform: "test", git: null },
    ...overrides,
  };
}

const lookup = (seq: number) => ({ seq, source: "observed" as const, type: "tool_call" as const, name: "lookup", args: null, result: 1 });
const answer = (caseId: string, value: JsonValue, toolCalls = 0): CaseResult => ({
  caseId,
  status: "completed",
  output: { kind: "answer", value },
  durationMs: 1,
  trace: Array.from({ length: toolCalls }, (_, seq) => lookup(seq)),
});
const abstain = (caseId: string, reason: string): CaseResult => ({
  caseId,
  status: "completed",
  output: { kind: "abstain", reason },
  durationMs: 1,
  trace: [],
});

const TAGS: Record<string, string[]> = { b: ["hard"], c: ["hard", "numbers"], f: ["tools"] };

/** Verdicts of a single evaluator, "correct", one per result. */
function run(candidateId: string, cases: [CaseResult, Outcome][], overrides: Partial<Manifest> = {}): RunData {
  const evaluations = cases.map(([result, outcome]): EvaluationRecord => ({
    caseId: result.caseId,
    evaluator: { id: "correct", version: "1" },
    verdict: outcome === "pass" || outcome === "fail" ? { outcome } : { outcome, detail: "x" },
  }));
  return {
    manifest: manifest(candidateId, overrides),
    cases: cases.map(([{ caseId }]) => ({ id: caseId, input: null, ...(TAGS[caseId] && { tags: TAGS[caseId] }) })),
    results: cases.map(([result]) => result),
    evaluations,
  };
}

const a = run("first", [
  [answer("a", 1), "pass"],
  [answer("b", 2), "pass"],
  [answer("c", 3), "fail"],
  [{ caseId: "d", status: "timeout", timeoutMs: 20, durationMs: 20, trace: [] }, "not_evaluated"],
  [abstain("e", "unknown"), "not_applicable"],
  [answer("f", { x: 1, y: [2] }, 1), "pass"],
]);
const b = run("second", [
  [answer("a", 1), "pass"],
  [answer("b", 9), "fail"],
  [answer("c", 4), "pass"],
  [{ caseId: "d", status: "error", error: { message: "boom" }, durationMs: 1, trace: [] }, "not_evaluated"],
  [abstain("e", "no idea"), "not_applicable"],
  [answer("f", { y: [2], x: 1 }, 2), "pass"],
]);

test("each evaluator's cases are split by the side it passed on", () => {
  assert.deepEqual(compare(a, b).evaluators, [
    {
      id: "correct",
      version: "1",
      both: ["a", "f"],
      onlyA: ["b"],
      onlyB: ["c"],
      neither: ["d"],
      notApplicable: ["e"],
      undetermined: [],
    },
  ]);
});

test("a check that applies on one side only, or failed itself, cannot be compared", () => {
  const mixed = run("second", [
    [answer("a", 1), "not_applicable"],
    [answer("b", 9), "error"],
    [answer("c", 4), "pass"],
    [{ caseId: "d", status: "error", error: { message: "boom" }, durationMs: 1, trace: [] }, "not_evaluated"],
    [abstain("e", "no idea"), "pass"],
    [answer("f", { y: [2], x: 1 }, 2), "pass"],
  ]);
  const [correct] = compare(a, mixed).evaluators;
  assert.deepEqual(correct?.undetermined, ["a", "b", "e"]);
  assert.deepEqual(correct?.notApplicable, []);
});

test("each case lists what observably differs between the sides", () => {
  const differences = Object.fromEntries(compare(a, b).cases.map((c) => [c.caseId, c.differences]));
  assert.deepEqual(differences, {
    a: [],
    b: ["output", "verdicts"],
    c: ["output", "verdicts"],
    d: ["status"],
    // The reason for abstaining is worded differently, which is not a different behaviour.
    e: [],
    // The same answer with its keys in another order; only the number of tool calls differs.
    f: ["tool_calls"],
  });
});

test("a comparison carries both runs' identity, summary and per-case facts", () => {
  const comparison = compare(a, b);
  assert.deepEqual(comparison.scenario, { id: "demo", version: "1" });
  assert.equal(comparison.a.runId, "2026-10-04T09-00-00Z_demo_first");
  assert.equal(comparison.b.candidate.id, "second");
  assert.deepEqual(comparison.b.summary.byStatus.error, ["d"]);
  assert.deepEqual(comparison.cases.at(-1), {
    caseId: "f",
    tags: ["tools"],
    a: { status: "completed", verdicts: { correct: "pass" }, toolCalls: 1, fallback: false, durationMs: 1 },
    b: { status: "completed", verdicts: { correct: "pass" }, toolCalls: 2, fallback: false, durationMs: 1 },
    differences: ["tool_calls"],
  });
});

test("each side's summary is also broken down by tag", () => {
  const { a: first, b: second } = compare(a, b);
  const passes = (summary: typeof first.summary) =>
    summary.byTag.map((tag) => [tag.tag, tag.caseIds, tag.evaluators[0]?.pass]);

  assert.deepEqual(passes(first.summary), [
    ["hard", ["b", "c"], ["b"]],
    ["numbers", ["c"], []],
    ["tools", ["f"], ["f"]],
  ]);
  assert.deepEqual(passes(second.summary), [
    ["hard", ["b", "c"], ["c"]],
    ["numbers", ["c"], ["c"]],
    ["tools", ["f"], ["f"]],
  ]);
});

test("a run can be compared with itself and shows no difference", () => {
  const comparison = compare(a, a);
  assert.ok(comparison.cases.every((c) => c.differences.length === 0));
  assert.deepEqual(comparison.evaluators[0]?.onlyA, []);
});

test("runs of different scenarios are refused outright", () => {
  const other = run("second", [], { scenario: { id: "other", version: "1" } });
  assert.deepEqual(comparability(a, other), ["they are runs of different scenarios (demo and other)"]);
  assert.throws(() => compare(a, other), /cannot be compared: they are runs of different scenarios/);
});

test("runs made under different conditions are refused, with every reason", () => {
  const changed: RunData = {
    ...b,
    manifest: manifest("second", {
      scenario: { id: "demo", version: "2" },
      dataset: { name: "dev", sha256: "b".repeat(64), caseCount: 6 },
      settings: { timeoutMs: 50 },
    }),
  };
  assert.deepEqual(comparability(a, changed), [
    "the scenario changed between them (version 1 and 2)",
    "they used different datasets (dev aaaaaaaa and dev bbbbbbbb)",
    "they ran with different time limits (20 ms and 50 ms)",
  ]);
});

test("runs that do not cover the same cases are refused", () => {
  const renamed: RunData = { ...b, results: b.results.map((r) => (r.caseId === "f" ? { ...r, caseId: "g" } : r)) };
  assert.ok(comparability(a, renamed).includes("their results do not cover the same cases"));
});

test("a run that is not fully scored is refused, with the command that fixes it", () => {
  const id = b.manifest.runId;
  assert.deepEqual(comparability(a, { ...b, evaluations: null }), [`${id} has not been scored: run "aql eval ${id}"`]);

  const incomplete = [`${id} has incomplete evaluations: run "aql eval ${id}"`];
  assert.deepEqual(comparability(a, { ...b, evaluations: b.evaluations!.slice(1) }), incomplete);
  assert.deepEqual(comparability(a, { ...b, evaluations: [...b.evaluations!, b.evaluations![0]!] }), incomplete);
});

test("runs scored with different evaluators are refused", () => {
  const rescored: RunData = {
    ...b,
    evaluations: b.evaluations!.map((record) => ({ ...record, evaluator: { id: "correct", version: "2" } })),
  };
  assert.deepEqual(comparability(a, rescored), [
    'they were scored with different evaluators (correct@1 and correct@2): score both again with "aql eval"',
  ]);
});
