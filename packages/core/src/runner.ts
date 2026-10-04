/**
 * Executes a candidate against the cases of a dataset and records what it
 * observably did. No filesystem access: a run is returned as plain data.
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
  type Manifest,
  type TraceEvent,
} from "./artifact.ts";
import type { Candidate, Case, Dataset, RunContext, Scenario, Tool } from "./types.ts";

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
  onCaseDone?: (result: CaseResult, done: number, total: number) => void;
}

type Clock = () => number;
type ToolCall = Extract<TraceEvent, { type: "tool_call" }>;
type Settled =
  | { how: "returned"; value: unknown }
  | { how: "threw"; error: unknown }
  | { how: "timed_out" };

const defaultClock: Clock = () => performance.now();

export async function executeRun<I, O, E>(
  scenario: Scenario<I, O, E>,
  candidate: Candidate<I, O>,
  dataset: Dataset<I, E>,
  options: RunOptions,
): Promise<Run> {
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? defaultClock;

  // Checked before any case runs, so a candidate that cannot be recorded fails fast.
  const candidateInfo = manifestSchema.shape.candidate.parse({
    id: candidate.id,
    version: candidate.version,
    config: candidate.config,
    deterministic: candidate.deterministic,
  });

  const startedAt = now();
  const results: CaseResult[] = [];
  for (const c of dataset.cases) {
    const result = await runCase(scenario, candidate, c, clock);
    results.push(result);
    options.onCaseDone?.(result, results.length, dataset.cases.length);
  }

  const manifest = manifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: runIdFor(startedAt, scenario.id, candidate.id),
    scenario: { id: scenario.id, version: scenario.version },
    dataset: { name: dataset.name, sha256: dataset.sha256, caseCount: dataset.cases.length },
    candidate: candidateInfo,
    settings: { timeoutMs: scenario.timeoutMs },
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    environment: options.environment,
  });
  return { manifest, results };
}

export async function runCase<I, O, E>(
  scenario: Pick<Scenario<I, O, E>, "tools" | "outputSchema" | "timeoutMs">,
  candidate: Pick<Candidate<I, O>, "run">,
  c: Case<I, E>,
  clock: Clock = defaultClock,
): Promise<CaseResult> {
  const trace: TraceEvent[] = [];
  // Once the case has ended, nothing the candidate still does is evidence about it.
  let open = true;
  const abort = new AbortController();

  const ctx: RunContext = {
    tools: observe(scenario.tools?.(c) ?? {}, trace, clock, () => open),
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
  // The candidate gets its own copy of the input, and a synchronous throw is caught like any other.
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
    return { ...base, status: "error", error: describeError(settled.error) };
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
): Record<string, Tool> {
  const observed: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    observed[name] = async (args) => {
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
        const result = await tool(structuredClone(checkedArgs.data));
        call.result = structuredClone(result);
        return result;
      } catch (error) {
        call.error = describeError(error).message;
        throw error;
      } finally {
        call.durationMs = roundMs(clock() - started);
      }
    };
  }
  return observed;
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack ? { message: error.message, stack: error.stack } : { message: error.message };
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function runIdFor(startedAt: Date, scenarioId: string, candidateId: string): string {
  const stamp = `${startedAt.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
  return `${stamp}_${scenarioId}_${candidateId}`;
}
