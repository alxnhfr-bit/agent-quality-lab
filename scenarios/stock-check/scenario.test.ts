import assert from "node:assert/strict";
import { test } from "node:test";
import { runCase, type CaseResult, type CompletedCase, type Verdict } from "@agent-quality-lab/core";
import { loadDataset } from "@agent-quality-lab/core/store";
import baseline from "./candidates/baseline.ts";
import mockAgent, { mockAgent as mockAgentWithSeed } from "./candidates/mock-agent.ts";
import scenario, { type Output } from "./scenario.ts";

const dataset = await loadDataset(scenario, "dev");
// The scenario's real limit only matters for how long a hanging candidate keeps the test waiting.
const quick = { ...scenario, timeoutMs: 10 };

async function runAll(candidate: typeof baseline): Promise<Map<string, CaseResult>> {
  const results = new Map<string, CaseResult>();
  for (const c of dataset.cases) results.set(c.id, await runCase(quick, candidate, c));
  return results;
}

function completed(result: CaseResult): CompletedCase<Output> {
  assert.equal(result.status, "completed");
  const { output } = result as Extract<CaseResult, { status: "completed" }>;
  if (output.kind === "abstain") return { ...result, output };
  const value = scenario.outputSchema.safeParse(output.value);
  assert.ok(value.success);
  return { ...result, output: { kind: "answer", value: value.data } };
}

async function verdicts(results: Map<string, CaseResult>, caseId: string): Promise<Record<string, Verdict>> {
  const c = dataset.cases.find((candidate) => candidate.id === caseId)!;
  const entries = await Promise.all(
    scenario.evaluators.map(async (e) => [e.id, await e.evaluate(c, completed(results.get(caseId)!))] as const),
  );
  return Object.fromEntries(entries);
}

test("the dev dataset has twelve cases, three of which call for abstaining", () => {
  assert.equal(dataset.cases.length, 12);
  assert.equal(dataset.cases.filter((c) => c.expected?.behaviour === "abstain").length, 3);
});

test("the baseline passes every evaluator on every case", async () => {
  const results = await runAll(baseline);
  for (const c of dataset.cases) {
    for (const [evaluator, verdict] of Object.entries(await verdicts(results, c.id))) {
      assert.equal(verdict.outcome, "pass", `${c.id} / ${evaluator}: ${JSON.stringify(verdict)}`);
    }
  }
});

test("the baseline recovers from a failed lookup by retrying once", async () => {
  const results = await runAll(baseline);
  const lookups = results.get("flaky-lookup")!.trace;
  assert.deepEqual(lookups.map((event) => event.type === "tool_call" && event.error), [
    "inventory service unavailable",
    undefined,
  ]);
});

test("the mock agent's default seed ends cases in every possible way", async () => {
  const results = await runAll(mockAgent);
  const statuses = Object.fromEntries([...results].map(([id, result]) => [id, result.status]));
  assert.deepEqual(statuses, {
    "in-stock": "timeout",
    "in-stock-exact": "completed",
    "small-exact": "malformed_output",
    "small-one-over": "completed",
    "out-of-stock": "completed",
    "bulk-exact": "completed",
    "bulk-one-over": "completed",
    "unknown-item": "error",
    "unknown-item-bulk": "completed",
    "flaky-lookup": "completed",
    "flaky-lookup-over": "completed",
    "service-down": "completed",
  });
});

test("a right answer reached by guessing passes correctness and fails tool-use", async () => {
  const results = await runAll(mockAgent);
  assert.ok(results.get("flaky-lookup")!.trace.some((event) => event.type === "fallback"));

  const { correctness, "tool-use": toolUse } = await verdicts(results, "flaky-lookup");
  assert.equal(correctness!.outcome, "pass");
  assert.deepEqual(toolUse, { outcome: "fail", value: 1, detail: "answered although no lookup succeeded" });
});

test("the evaluators tell a wrong answer, a missed abstention and a wasted lookup apart", async () => {
  const results = await runAll(mockAgent);
  assert.deepEqual(await verdicts(results, "small-one-over"), {
    correctness: { outcome: "fail", detail: "expected canFulfil to be false" },
    "tool-use": { outcome: "pass", value: 1 },
  });
  assert.deepEqual((await verdicts(results, "service-down")).correctness, {
    outcome: "fail",
    detail: "answered when the stock level could not be established",
  });
  assert.deepEqual(await verdicts(results, "in-stock-exact"), {
    correctness: { outcome: "pass" },
    "tool-use": { outcome: "fail", value: 2, detail: "made 2 lookups where 1 suffice" },
  });
});

test("the same seed gives the same run, and another seed a different one", async () => {
  const outcome = (results: Map<string, CaseResult>) =>
    [...results.values()].map((r) => [r.caseId, r.status, r.status === "completed" && r.output, r.trace.length]);

  assert.deepEqual(outcome(await runAll(mockAgentWithSeed(49))), outcome(await runAll(mockAgent)));
  assert.notDeepEqual(outcome(await runAll(mockAgentWithSeed(12))), outcome(await runAll(mockAgent)));
});
