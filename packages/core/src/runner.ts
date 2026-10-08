/**
 * Executes a candidate against the cases of a dataset and records what it
 * observably did. No filesystem access: a run is returned as plain data, and
 * the caller can be told about each result as it arrives.
 *
 * The runner never retries and never substitutes an output. Each case ends in
 * exactly one of four ways (completed, malformed_output, error, timeout) and is
 * recorded as what it was.
 */
import { z } from "zod";
import {
  SCHEMA_VERSION,
  candidateOutputSchema,
  jsonSchema,
  manifestSchema,
  traceEventSchema,
  type CaseResult,
  type JsonValue,
  type Manifest,
  type TraceEvent,
} from "./artifact.ts";
import { costOf } from "./cost.ts";
import {
  CandidateUnavailable,
  type AvailableTool,
  type Candidate,
  type Case,
  type Dataset,
  type RunContext,
  type Scenario,
  type Tool,
} from "./types.ts";

export interface Run {
  manifest: Manifest;
  results: CaseResult[];
}

export interface RunOptions {
  environment: Manifest["environment"];
  /** Wall clock, for the manifest timestamps. */
  now?: () => Date;
  /** Monotonic milliseconds, for durations. */
  clock?: () => number;
  /** Applied to stack traces before they are recorded, e.g. to keep local paths out of a run. */
  cleanStack?: (stack: string) => string;
  /** How many cases run at the same time. One by default. */
  concurrency?: number;
  /**
   * Once the model calls so far have cost more than this, no further case is
   * started and the run is recorded as stopped. In the currency of the candidate's prices.
   */
  maxCost?: number;
  /** Called once before the first case, with the manifest as far as it is known. */
  onStart?: (manifest: Manifest) => void | Promise<void>;
  /** Called as each case finishes, in the order they finish. */
  onCaseDone?: (result: CaseResult, done: number, total: number) => void | Promise<void>;
}

type Clock = () => number;
type ToolCall = Extract<TraceEvent, { type: "tool_call" }>;
type OfferedTools = NonNullable<Manifest["scenario"]["tools"]>;
type CaseScenario<I, O, E, S> = Pick<
  Scenario<I, O, E, S>,
  "instructions" | "answerFormat" | "tools" | "outputSchema" | "timeoutMs"
>;
type Settled =
  | { how: "returned"; value: unknown }
  | { how: "threw"; error: unknown }
  | { how: "timed_out" };

const defaultClock: Clock = () => performance.now();

export async function executeRun<I, O, E, S>(
  scenario: Scenario<I, O, E, S>,
  candidate: Candidate<I, O>,
  dataset: Dataset<I, E, S>,
  options: RunOptions,
): Promise<Run> {
  const now = options.now ?? (() => new Date());
  const total = dataset.cases.length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, total));

  // What every candidate is offered is one fact about the run, so it is taken from the
  // first case and every other case has to match it.
  const first = dataset.cases[0];
  const offered = first ? describeTools(scenario.tools?.(first) ?? {}) : [];

  const startedAt = now();
  // Checked before any case runs, so a candidate that cannot be recorded fails fast.
  const started = manifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: runIdFor(startedAt, scenario.id, candidate.id),
    scenario: {
      id: scenario.id,
      version: scenario.version,
      instructions: scenario.instructions,
      tools: offered,
    },
    dataset: { name: dataset.name, sha256: dataset.sha256, caseCount: total },
    candidate: {
      id: candidate.id,
      version: candidate.version,
      config: candidate.config,
      deterministic: candidate.deterministic,
    },
    settings: { timeoutMs: scenario.timeoutMs, concurrency },
    ...(candidate.prices && { prices: candidate.prices }),
    startedAt: startedAt.toISOString(),
    environment: options.environment,
  });
  await options.onStart?.(started);

  const results = new Array<CaseResult | undefined>(total);
  const waiting = [...dataset.cases.entries()];
  let done = 0;
  let spent = 0;
  let stopped: string | undefined;

  const work = async () => {
    for (let next = waiting.shift(); next && stopped === undefined; next = waiting.shift()) {
      const [index, c] = next;
      let executed;
      try {
        executed = await executeCase(scenario, candidate, c, options);
      } catch (error) {
        if (!(error instanceof CandidateUnavailable)) throw error;
        stopped ??= `the candidate could not run: ${error.message}`;
        return;
      }
      const { result, tools } = executed;
      if (JSON.stringify(tools) !== JSON.stringify(offered)) {
        throw new Error(
          `scenario "${scenario.id}" offers different tools for case "${c.id}" than for case "${first!.id}"`,
        );
      }
      results[index] = result;
      done += 1;
      await options.onCaseDone?.(result, done, total);

      if (options.maxCost === undefined) continue;
      const cost = costOf(result.trace, started.prices);
      spent += cost.total;
      const limit = `the spending limit of ${options.maxCost.toFixed(2)} USD`;
      if (cost.unpriced > 0) {
        stopped ??= `a model call could not be priced, so ${limit} cannot be enforced`;
      } else if (spent > options.maxCost) {
        stopped ??= `${limit} was passed after ${done} of ${total} cases`;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));

  const manifest = manifestSchema.parse({
    ...started,
    finishedAt: now().toISOString(),
    ...(stopped !== undefined && { stopped: { reason: stopped } }),
  });
  // In dataset order, whatever order the cases finished in.
  return { manifest, results: results.filter((result) => result !== undefined) };
}

export async function runCase<I, O, E, S>(
  scenario: CaseScenario<I, O, E, S>,
  candidate: Pick<Candidate<I, O>, "run">,
  c: Case<I, E, S>,
  options: Pick<RunOptions, "clock" | "cleanStack"> = {},
): Promise<CaseResult> {
  return (await executeCase(scenario, candidate, c, options)).result;
}

/** Runs one case, and also says which tools the candidate was offered for it. */
async function executeCase<I, O, E, S>(
  scenario: CaseScenario<I, O, E, S>,
  candidate: Pick<Candidate<I, O>, "run">,
  c: Case<I, E, S>,
  options: Pick<RunOptions, "clock" | "cleanStack">,
): Promise<{ result: CaseResult; tools: OfferedTools }> {
  const caseTools = scenario.tools?.(c) ?? {};
  return { result: await runWithTools(scenario, candidate, c, caseTools, options), tools: describeTools(caseTools) };
}

function describeTools(tools: Record<string, Tool>): OfferedTools {
  return Object.entries(tools).map(([name, { description, parameters }]) => ({ name, description, parameters }));
}

async function runWithTools<I, O, E, S>(
  scenario: CaseScenario<I, O, E, S>,
  candidate: Pick<Candidate<I, O>, "run">,
  c: Case<I, E, S>,
  caseTools: Record<string, Tool>,
  options: Pick<RunOptions, "clock" | "cleanStack">,
): Promise<CaseResult> {
  const clock = options.clock ?? defaultClock;
  const trace: TraceEvent[] = [];
  // Once the case has ended, nothing the candidate still does is evidence about it.
  let open = true;
  const abort = new AbortController();

  const ctx: RunContext = {
    instructions: scenario.instructions,
    answerFormat: scenario.answerFormat,
    tools: observe(caseTools, trace, clock, () => open),
    report(event) {
      if (!open) return;
      const parsed = traceEventSchema.safeParse({ ...event, seq: trace.length, source: "reported" });
      if (!parsed.success) {
        throw new Error(`reported an invalid trace event: ${z.prettifyError(parsed.error)}`);
      }
      trace.push(parsed.data);
    },
    signal: abort.signal,
  };

  const started = clock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ how: "timed_out" }), scenario.timeoutMs);
  });
  // The candidate gets its own copy of the input and nothing else of the case: what the case
  // expects and its setup stay with the lab. A synchronous throw is caught like any other.
  const attempt: Promise<Settled> = (async () => candidate.run(structuredClone(c.input), ctx))().then(
    (value) => ({ how: "returned", value }),
    (error) => ({ how: "threw", error }),
  );

  const settled = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  open = false;
  abort.abort();

  const base = {
    caseId: c.id,
    trace: structuredClone(trace),
    durationMs: roundMs(clock() - started),
  };

  if (settled.how === "timed_out") {
    return { ...base, status: "timeout", timeoutMs: scenario.timeoutMs };
  }
  if (settled.how === "threw") {
    // Not a result for this case: the candidate is saying it cannot run at all.
    if (settled.error instanceof CandidateUnavailable) throw settled.error;
    return { ...base, status: "error", error: describeError(settled.error, options.cleanStack) };
  }

  const malformed = (problem: string): CaseResult => {
    const raw = jsonSchema.safeParse(settled.value);
    return raw.success
      ? { ...base, status: "malformed_output", problem, rawOutput: raw.data }
      : { ...base, status: "malformed_output", problem: `${problem} (the returned value cannot be stored as JSON)` };
  };

  const output = candidateOutputSchema.safeParse(settled.value);
  if (!output.success) {
    return malformed('expected { kind: "answer", value } or { kind: "abstain", reason }');
  }
  if (output.data.kind === "answer") {
    const answer = scenario.outputSchema.safeParse(output.data.value);
    if (!answer.success) {
      return malformed(`answer does not match the scenario's output schema: ${answer.error.message}`);
    }
  }
  return { ...base, status: "completed", output: output.data };
}

/** Wraps lab-owned tools so every call the candidate makes lands in the trace. */
function observe(
  tools: Record<string, Tool>,
  trace: TraceEvent[],
  clock: Clock,
  isOpen: () => boolean,
): Record<string, AvailableTool> {
  const observed: Record<string, AvailableTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const invoke = async (args: JsonValue): Promise<JsonValue> => {
      if (!isOpen()) throw new Error(`tool "${name}" was called after the case ended`);

      const checkedArgs = jsonSchema.safeParse(args);
      // Recorded when the call starts, so a call that never returns is still in the trace.
      const call: ToolCall = {
        seq: trace.length,
        source: "observed",
        type: "tool_call",
        name,
        args: checkedArgs.success ? checkedArgs.data : null,
      };
      trace.push(call);
      if (!checkedArgs.success) {
        call.error = "arguments are not valid JSON";
        throw new Error(`tool "${name}": ${call.error}`);
      }

      const started = clock();
      try {
        const result = await tool.run(structuredClone(checkedArgs.data));
        call.result = structuredClone(result);
        return result;
      } catch (error) {
        call.error = describeError(error).message;
        throw error;
      } finally {
        call.durationMs = roundMs(clock() - started);
      }
    };
    observed[name] = Object.assign(invoke, { description: tool.description, parameters: tool.parameters });
  }
  return observed;
}

function describeError(
  error: unknown,
  cleanStack: (stack: string) => string = (stack) => stack,
): { message: string; stack?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack
    ? { message: error.message, stack: cleanStack(error.stack) }
    : { message: error.message };
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function runIdFor(startedAt: Date, scenarioId: string, candidateId: string): string {
  const stamp = `${startedAt.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
  return `${stamp}_${scenarioId}_${candidateId}`;
}
