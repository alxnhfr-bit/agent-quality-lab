/**
 * The contracts a scenario author and a candidate author implement.
 *
 * Type parameters used throughout:
 *   I  input a case hands to the candidate
 *   O  value a candidate returns when it answers
 *   E  ground truth, in whatever shape the scenario's evaluators need
 *   S  the hidden facts of a case, for scenarios whose tools depend on the case
 */
import type { JsonValue, Judgment, TraceEvent } from "./artifact.ts";

/** Anything with a zod-compatible `safeParse`, so scenarios are not tied to one validator. */
export interface Schema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export interface Case<I, E, S = undefined> {
  /** Stable across dataset versions; runs are compared by joining on it. */
  id: string;
  /** All the candidate is given. Anything else it learns, it learns through tools. */
  input: I;
  /** Absent when the case has no ground truth. */
  expected?: E;
  /**
   * The world of this case: its facts, and what goes wrong in it. The scenario
   * builds the case's tools from it and evaluators may read it. The candidate
   * never receives it.
   */
  setup?: S;
  tags?: string[];
}

export interface Dataset<I, E, S = undefined> {
  name: string;
  /** Hash of `text`. */
  sha256: string;
  /** The file exactly as read; snapshotted into every run that uses it. */
  text: string;
  cases: Case<I, E, S>[];
}

/** Abstaining is a legitimate result, distinct from failing to produce one. */
export type CandidateOutput<O> =
  | { kind: "answer"; value: O }
  | { kind: "abstain"; reason: string };

/** A lab-owned tool. Every call a candidate makes through one is recorded as observed. */
export type Tool = (args: JsonValue) => Promise<JsonValue>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A trace event as a candidate describes it; the lab adds the ordering and marks it as reported. */
export type ReportedEvent = DistributiveOmit<TraceEvent, "seq" | "source">;

export interface RunContext {
  /** Empty when the scenario provides no tools. */
  tools: Readonly<Record<string, Tool>>;
  /**
   * For behaviour the lab cannot see: calls to the candidate's own tools or
   * models, and any fallback path it took.
   */
  report(event: ReportedEvent): void;
  /** Aborted when the case exceeds the scenario's time limit. */
  signal: AbortSignal;
}

/** Any system that takes a case input and produces an output: a model, an agent, a workflow, a program. */
export interface Candidate<I, O> {
  id: string;
  version: string;
  /** Everything that determines behaviour (model, prompt, seed, thresholds). Stored in the manifest. */
  config: JsonValue;
  /** Whether the same input and config are expected to produce the same output. */
  deterministic: boolean;
  run(input: I, ctx: RunContext): Promise<CandidateOutput<O>>;
}

/** A case the candidate finished with a well-formed output. Evaluators only ever see these. */
export interface CompletedCase<O> {
  output: CandidateOutput<O>;
  trace: readonly TraceEvent[];
  durationMs: number;
}

/** Judges one aspect of a completed case against an expectation. */
export interface Evaluator<I, O, E, S = undefined> {
  id: string;
  /** Change it whenever the judgment changes, so old and new verdicts are not mixed. */
  version: string;
  evaluate(c: Case<I, E, S>, completed: CompletedCase<O>): Judgment | Promise<Judgment>;
}

export interface Scenario<I, O, E, S = undefined> {
  id: string;
  version: string;
  inputSchema: Schema<I>;
  outputSchema: Schema<O>;
  expectedSchema: Schema<E>;
  /** Required for a scenario whose cases carry a setup; a dataset with setups is refused without it. */
  setupSchema?: Schema<S>;
  /** Dataset name → JSONL file with one case per line. */
  datasets: Record<string, URL>;
  /** Built fresh for each case so state never leaks between cases. */
  tools?(c: Case<I, E, S>): Record<string, Tool>;
  evaluators: Evaluator<I, O, E, S>[];
  /** Per-case time limit. Recorded in the manifest. */
  timeoutMs: number;
}
