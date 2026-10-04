import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { executeRun, runCase } from "./runner.ts";
import type { Candidate, Case, Dataset, RunContext, Scenario, Tool } from "./types.ts";

type In = { n: number };
type Out = { n: number };

const outputSchema = z.strictObject({ n: z.number() });
const c: Case<In, never> = { id: "c1", input: { n: 2 } };

const scenarioWith = (tools?: () => Record<string, Tool>) => ({ outputSchema, timeoutMs: 20, tools });
const candidate = (run: Candidate<In, Out>["run"]) => ({ run });
/** A clock that advances 5 ms every time it is read. */
const ticking = () => {
  let t = 0;
  return () => (t += 5);
};
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

const tools = (): Record<string, Tool> => ({
  double: async (args) => ({ n: (args as In).n * 2 }),
  broken: async () => {
    throw new Error("unavailable");
  },
  stuck: () => new Promise(() => {}),
});

test("an answer that fits the output schema completes", async () => {
  const result = await runCase(
    scenarioWith(),
    candidate(async ({ n }) => ({ kind: "answer", value: { n } })),
    c,
    ticking(),
  );
  assert.deepEqual(result, {
    caseId: "c1",
    status: "completed",
    output: { kind: "answer", value: { n: 2 } },
    trace: [],
    durationMs: 5,
  });
});

test("abstaining completes", async () => {
  const result = await runCase(
    scenarioWith(),
    candidate(async () => ({ kind: "abstain", reason: "cannot tell" })),
    c,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, { kind: "abstain", reason: "cannot tell" });
});

test("a candidate that throws is recorded as an error, whether or not it is async", async () => {
  const rejecting = await runCase(scenarioWith(), candidate(async () => Promise.reject(new Error("boom"))), c);
  const throwing = await runCase(
    scenarioWith(),
    candidate(() => {
      throw "plain string";
    }),
    c,
  );
  assert.equal(rejecting.status === "error" && rejecting.error.message, "boom");
  assert.equal(throwing.status === "error" && throwing.error.message, "plain string");
});

test("output that is not an answer or an abstention is malformed, and kept", async () => {
  const result = await runCase(scenarioWith(), candidate(async () => "4" as never), c);
  assert.equal(result.status, "malformed_output");
  assert.equal(result.status === "malformed_output" && result.rawOutput, "4");
});

test("an answer that does not fit the scenario's output schema is malformed", async () => {
  const returned = { kind: "answer", value: { n: "two" } };
  const result = await runCase(scenarioWith(), candidate(async () => returned as never), c);
  assert.equal(result.status, "malformed_output");
  assert.deepEqual(result.status === "malformed_output" && result.rawOutput, returned);
  assert.match(result.status === "malformed_output" ? result.problem : "", /output schema/);
});

test("output that cannot be stored as JSON is malformed, not coerced", async () => {
  for (const returned of [undefined, { kind: "answer", value: { n: Number.NaN } }]) {
    const result = await runCase(scenarioWith(), candidate(async () => returned as never), c);
    assert.equal(result.status, "malformed_output");
    assert.equal("rawOutput" in result, false);
    assert.match(result.status === "malformed_output" ? result.problem : "", /cannot be stored as JSON/);
  }
});

test("a candidate that does not finish in time is a timeout, and is told to stop", async () => {
  let signal: AbortSignal | undefined;
  const result = await runCase(
    scenarioWith(),
    candidate((_input, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    }),
    c,
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.status === "timeout" && result.timeoutMs, 20);
  assert.equal(signal?.aborted, true);
});

test("tool calls are observed in order, with arguments, results and durations", async () => {
  const result = await runCase(
    scenarioWith(tools),
    candidate(async ({ n }, ctx) => {
      const once = (await ctx.tools.double!({ n })) as Out;
      const twice = (await ctx.tools.double!(once)) as Out;
      return { kind: "answer", value: twice };
    }),
    c,
    ticking(),
  );
  assert.deepEqual(result.trace, [
    { seq: 0, source: "observed", type: "tool_call", name: "double", args: { n: 2 }, result: { n: 4 }, durationMs: 5 },
    { seq: 1, source: "observed", type: "tool_call", name: "double", args: { n: 4 }, result: { n: 8 }, durationMs: 5 },
  ]);
});

test("a failed tool call is recorded, and the candidate may recover from it", async () => {
  const result = await runCase(
    scenarioWith(tools),
    candidate(async ({ n }, ctx) => {
      await ctx.tools.broken!(null).catch(() => {});
      return { kind: "answer", value: { n } };
    }),
    c,
    ticking(),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.trace, [
    { seq: 0, source: "observed", type: "tool_call", name: "broken", args: null, error: "unavailable", durationMs: 5 },
  ]);
});

test("events the candidate reports are marked as reported and ordered with observed ones", async () => {
  const result = await runCase(
    scenarioWith(tools),
    candidate(async ({ n }, ctx) => {
      ctx.report({ type: "model_call", model: "m" });
      await ctx.tools.double!({ n });
      ctx.report({ type: "fallback", from: "m", to: "rules", reason: "rate limited" });
      return { kind: "abstain", reason: "x" };
    }),
    c,
  );
  assert.deepEqual(
    result.trace.map((event) => [event.seq, event.source, event.type]),
    [
      [0, "reported", "model_call"],
      [1, "observed", "tool_call"],
      [2, "reported", "fallback"],
    ],
  );
});

test("reporting an invalid event fails the case rather than corrupting the trace", async () => {
  const result = await runCase(
    scenarioWith(),
    candidate(async (_input, ctx) => {
      ctx.report({ type: "model_call" } as never);
      return { kind: "abstain", reason: "x" };
    }),
    c,
  );
  assert.equal(result.status, "error");
  assert.deepEqual(result.trace, []);
});

test("a tool call still pending when the case ends is recorded without a result", async () => {
  const result = await runCase(scenarioWith(tools), candidate(async (_input, ctx) => ctx.tools.stuck!(1) as never), c);
  assert.equal(result.status, "timeout");
  assert.deepEqual(result.trace, [{ seq: 0, source: "observed", type: "tool_call", name: "stuck", args: 1 }]);
});

test("nothing a candidate does after its case ended reaches the trace", async () => {
  let late: Promise<unknown> | undefined;
  const result = await runCase(
    scenarioWith(tools),
    candidate(async (_input, ctx) => {
      await aborted(ctx.signal);
      ctx.report({ type: "model_call", model: "m" });
      late = ctx.tools.double!({ n: 1 }).catch((error: Error) => error.message);
      return { kind: "abstain", reason: "too late" };
    }),
    c,
  );
  assert.match(String(await late), /after the case ended/);
  assert.equal(result.status, "timeout");
  assert.deepEqual(result.trace, []);
});

test("the candidate gets its own copy of the input", async () => {
  const original: Case<In, never> = { id: "c1", input: { n: 2 } };
  await runCase(
    scenarioWith(),
    candidate(async (input) => {
      input.n = 99;
      return { kind: "abstain", reason: "x" };
    }),
    original,
  );
  assert.deepEqual(original.input, { n: 2 });
});

// --- executeRun --------------------------------------------------------------

const scenario: Scenario<In, Out, never> = {
  id: "demo",
  version: "3",
  inputSchema: z.strictObject({ n: z.number() }),
  outputSchema,
  expectedSchema: z.never(),
  datasets: {},
  evaluators: [],
  timeoutMs: 20,
};
const dataset: Dataset<In, never> = {
  name: "dev",
  sha256: "b".repeat(64),
  text: "",
  cases: [
    { id: "a", input: { n: 1 } },
    { id: "b", input: { n: 2 } },
    { id: "c", input: { n: 3 } },
  ],
};
const environment = { node: "v24.0.0", platform: "test", git: null };

function countingCandidate(overrides: Partial<Candidate<In, Out>> = {}) {
  const seen: number[] = [];
  const counting: Candidate<In, Out> = {
    id: "echo",
    version: "1",
    config: { mode: "echo" },
    deterministic: true,
    async run({ n }: In, _ctx: RunContext) {
      seen.push(n);
      if (n === 2) throw new Error("boom");
      return { kind: "answer", value: { n } };
    },
    ...overrides,
  };
  return { counting, seen };
}

test("a run records what was executed and one result per case, in dataset order", async () => {
  const { counting } = countingCandidate();
  const times = [new Date("2026-10-04T09:00:00Z"), new Date("2026-10-04T09:00:02Z")];
  const progress: string[] = [];

  const run = await executeRun(scenario, counting, dataset, {
    environment,
    now: () => times.shift()!,
    clock: ticking(),
    onCaseDone: (result, done, total) => progress.push(`${done}/${total} ${result.caseId} ${result.status}`),
  });

  assert.deepEqual(run.manifest, {
    schemaVersion: 1,
    runId: "2026-10-04T09-00-00Z_demo_echo",
    scenario: { id: "demo", version: "3" },
    dataset: { name: "dev", sha256: "b".repeat(64), caseCount: 3 },
    candidate: { id: "echo", version: "1", config: { mode: "echo" }, deterministic: true },
    settings: { timeoutMs: 20 },
    startedAt: "2026-10-04T09:00:00.000Z",
    finishedAt: "2026-10-04T09:00:02.000Z",
    environment,
  });
  assert.deepEqual(progress, ["1/3 a completed", "2/3 b error", "3/3 c completed"]);
  assert.deepEqual(run.results.map((result) => result.caseId), ["a", "b", "c"]);
});

test("a failed case is not retried", async () => {
  const { counting, seen } = countingCandidate();
  await executeRun(scenario, counting, dataset, { environment });
  assert.deepEqual(seen, [1, 2, 3]);
});

test("a candidate that cannot be recorded is rejected before any case runs", async () => {
  const { counting, seen } = countingCandidate({ id: "not/a/slug" });
  await assert.rejects(executeRun(scenario, counting, dataset, { environment }));
  assert.deepEqual(seen, []);
});
