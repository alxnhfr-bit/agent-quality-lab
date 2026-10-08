import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { executeRun, runCase } from "./runner.ts";
import { CandidateUnavailable, type Candidate, type Case, type Dataset, type RunContext, type Scenario, type Tool } from "./types.ts";

type In = { n: number };
type Out = { n: number };

const outputSchema = z.strictObject({ n: z.number() });
const c: Case<In, never> = { id: "c1", input: { n: 2 } };

const INSTRUCTIONS = "Answer with a number.";
const answerFormat = { type: "object" };
const scenarioWith = (tools?: () => Record<string, Tool>) => ({
  instructions: INSTRUCTIONS,
  answerFormat,
  outputSchema,
  timeoutMs: 20,
  tools,
});
/** A tool in the form a scenario defines it, around the function that does the work. */
const tool = (run: Tool["run"], description = "A test tool."): Tool => ({
  description,
  parameters: { type: "object" },
  run,
});
const candidate = (run: Candidate<In, Out>["run"]) => ({ run });
/** A clock that advances 5 ms every time it is read. */
const ticking = () => {
  let t = 0;
  return () => (t += 5);
};
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

const tools = (): Record<string, Tool> => ({
  double: tool(async (args) => ({ n: (args as In).n * 2 }), "Doubles a number."),
  broken: tool(async () => {
    throw new Error("unavailable");
  }),
  stuck: tool(() => new Promise(() => {})),
});

test("an answer that fits the output schema completes", async () => {
  const result = await runCase(
    scenarioWith(),
    candidate(async ({ n }) => ({ kind: "answer", value: { n } })),
    c,
    { clock: ticking() },
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

test("a recorded stack trace goes through the cleaner the run was given", async () => {
  const result = await runCase(scenarioWith(), candidate(async () => Promise.reject(new Error("boom"))), c, {
    cleanStack: (stack) => stack.split("\n")[0]!,
  });
  assert.deepEqual(result.status === "error" && result.error, { message: "boom", stack: "Error: boom" });
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
    { clock: ticking() },
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
    { clock: ticking() },
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
  answerFormat,
  expectedSchema: z.never(),
  instructions: INSTRUCTIONS,
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
    onCaseDone: (result, done, total) => {
      progress.push(`${done}/${total} ${result.caseId} ${result.status}`);
    },
  });

  assert.deepEqual(run.manifest, {
    schemaVersion: 1,
    runId: "2026-10-04T09-00-00Z_demo_echo",
    scenario: { id: "demo", version: "3", instructions: INSTRUCTIONS, tools: [] },
    dataset: { name: "dev", sha256: "b".repeat(64), caseCount: 3 },
    candidate: { id: "echo", version: "1", config: { mode: "echo" }, deterministic: true },
    settings: { timeoutMs: 20, concurrency: 1 },
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

// --- A hidden setup per case ---------------------------------------------------

type Question = { item: string };
type World = { stock: number; lookupFails?: boolean };

const worldScenario = {
  instructions: INSTRUCTIONS,
  answerFormat,
  outputSchema: z.strictObject({ stock: z.number() }),
  timeoutMs: 20,
  tools: (c: Case<Question, never, World>): Record<string, Tool> => ({
    lookup: tool(async () => {
      if (c.setup!.lookupFails) throw new Error("unavailable");
      return c.setup!.stock;
    }),
  }),
};
const askingTheTool: Pick<Candidate<Question, { stock: number }>, "run"> = {
  run: async (_input, ctx) => ({ kind: "answer", value: { stock: (await ctx.tools.lookup!(null)) as number } }),
};

test("each case's tools answer from that case's own setup", async () => {
  const stockOf = async (setup: World) => {
    const result = await runCase(worldScenario, askingTheTool, { id: "c", input: { item: "kettle" }, setup });
    return result.status === "completed" && result.output.kind === "answer" ? result.output.value : result.status;
  };
  assert.deepEqual(await stockOf({ stock: 3 }), { stock: 3 });
  assert.deepEqual(await stockOf({ stock: 40 }), { stock: 40 });
  assert.equal(await stockOf({ stock: 3, lookupFails: true }), "error");
});

test("the candidate is given the input and nothing else of the case", async () => {
  const received: unknown[][] = [];
  const result = await runCase(
    worldScenario,
    {
      run: async (...args: unknown[]) => {
        received.push(args);
        return { kind: "abstain", reason: "did not look" };
      },
    },
    { id: "c", input: { item: "kettle" }, expected: undefined as never, setup: { stock: 31337 } },
  );

  assert.equal(received.length, 1);
  const [input, ctx, ...rest] = received[0]!;
  assert.deepEqual(input, { item: "kettle" });
  // The instructions belong to the scenario and are the same for every case.
  assert.deepEqual(Object.keys(ctx as object).sort(), ["answerFormat", "instructions", "report", "signal", "tools"]);
  assert.deepEqual(rest, []);
  // It did not look anything up, so the hidden fact appears nowhere in what was recorded.
  assert.equal(JSON.stringify(result).includes("31337"), false);
});

// --- What a candidate is told ---------------------------------------------------

test("a candidate can read the instructions and what each tool is for", async () => {
  let told: unknown;
  await runCase(
    scenarioWith(tools),
    candidate(async (_input, ctx) => {
      told = {
        instructions: ctx.instructions,
        double: [ctx.tools.double!.description, ctx.tools.double!.parameters],
        names: Object.keys(ctx.tools),
      };
      return { kind: "abstain", reason: "just looking" };
    }),
    c,
  );
  assert.deepEqual(told, {
    instructions: INSTRUCTIONS,
    double: ["Doubles a number.", { type: "object" }],
    names: ["double", "broken", "stuck"],
  });
});

test("a run records what every candidate was told: the instructions and the tools", async () => {
  const { counting } = countingCandidate();
  const run = await executeRun({ ...scenario, tools }, counting, dataset, { environment });
  assert.equal(run.manifest.scenario.instructions, INSTRUCTIONS);
  assert.deepEqual(run.manifest.scenario.tools, [
    { name: "double", description: "Doubles a number.", parameters: { type: "object" } },
    { name: "broken", description: "A test tool.", parameters: { type: "object" } },
    { name: "stuck", description: "A test tool.", parameters: { type: "object" } },
  ]);
});

test("a scenario that offers different tools from case to case is refused", async () => {
  const { counting } = countingCandidate();
  const shifting = {
    ...scenario,
    tools: (shifted: Case<In, never>) => ({
      double: tool(async () => 0, shifted.input.n === 3 ? "Triples a number." : "Doubles a number."),
    }),
  };
  await assert.rejects(
    executeRun(shifting, counting, dataset, { environment }),
    /offers different tools for case "c" than for case "a"/,
  );
});

// --- Several cases at once, and a spending limit --------------------------------

const PRICES = { currency: "USD" as const, asOf: "2026-09-25", perMillionTokens: { m: { input: 1, output: 1 } } };

/** Finishes the cases in reverse order, and reports one model call of a million tokens each: one dollar. */
function slowestFirst(overrides: Partial<Candidate<In, Out>> = {}) {
  let running = 0;
  let mostAtOnce = 0;
  const paid: Candidate<In, Out> = {
    id: "paid",
    version: "1",
    config: null,
    deterministic: false,
    prices: PRICES,
    async run({ n }, ctx) {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, (4 - n) * 4));
      ctx.report({ type: "model_call", model: "m", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
      running -= 1;
      return { kind: "answer", value: { n } };
    },
    ...overrides,
  };
  return { paid, mostAtOnce: () => mostAtOnce };
}

test("cases can run at the same time, and the results still come back in dataset order", async () => {
  const { paid, mostAtOnce } = slowestFirst();
  const finished: string[] = [];
  const run = await executeRun(scenario, paid, dataset, {
    environment,
    concurrency: 3,
    onCaseDone: (result) => {
      finished.push(result.caseId);
    },
  });
  assert.equal(mostAtOnce(), 3);
  assert.deepEqual(finished, ["c", "b", "a"]);
  assert.deepEqual(run.results.map((result) => result.caseId), ["a", "b", "c"]);
  assert.equal(run.manifest.settings.concurrency, 3);
  assert.deepEqual(run.manifest.prices, PRICES);
});

test("the manifest is available before the first case, without an end time", async () => {
  const { paid } = slowestFirst();
  const order: string[] = [];
  const run = await executeRun(scenario, paid, dataset, {
    environment,
    onStart: (manifest) => {
      order.push(`start ${manifest.runId === undefined ? "?" : "known"} ${manifest.finishedAt ?? "unfinished"}`);
    },
    onCaseDone: (result) => {
      order.push(result.caseId);
    },
  });
  assert.deepEqual(order, ["start known unfinished", "a", "b", "c"]);
  assert.notEqual(run.manifest.finishedAt, undefined);
  assert.equal(run.manifest.stopped, undefined);
});

test("a run stops starting cases once it has cost more than its limit", async () => {
  const { paid } = slowestFirst();
  const run = await executeRun(scenario, paid, dataset, { environment, maxCost: 1.5 });
  // One dollar per case: after the second case the limit of 1.50 is passed, so the third never starts.
  assert.deepEqual(run.results.map((result) => result.caseId), ["a", "b"]);
  assert.deepEqual(run.manifest.stopped, {
    reason: "the spending limit of 1.50 USD was passed after 2 of 3 cases",
  });
});

test("a limit that is not reached changes nothing", async () => {
  const { paid } = slowestFirst();
  const run = await executeRun(scenario, paid, dataset, { environment, maxCost: 5 });
  assert.equal(run.results.length, 3);
  assert.equal(run.manifest.stopped, undefined);
});

test("under a spending limit, a model call that cannot be priced stops the run", async () => {
  const { paid } = slowestFirst({ prices: { ...PRICES, perMillionTokens: {} } });
  const run = await executeRun(scenario, paid, dataset, { environment, maxCost: 5 });
  assert.deepEqual(run.results.map((result) => result.caseId), ["a"]);
  assert.deepEqual(run.manifest.stopped, {
    reason: "a model call could not be priced, so the spending limit of 5.00 USD cannot be enforced",
  });
});

test("a candidate that cannot run at all stops the run, and no case is blamed for it", async () => {
  const { paid } = slowestFirst({
    run: async () => {
      throw new CandidateUnavailable("no credentials are set up");
    },
  });
  const run = await executeRun(scenario, paid, dataset, { environment, concurrency: 2 });
  assert.deepEqual(run.results, []);
  assert.deepEqual(run.manifest.stopped, { reason: "the candidate could not run: no credentials are set up" });

  await assert.rejects(runCase(scenarioWith(), paid, c), CandidateUnavailable);
});
