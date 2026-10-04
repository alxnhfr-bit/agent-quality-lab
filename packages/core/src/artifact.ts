/**
 * On-disk format of a run.
 *
 *   runs/<run-id>/
 *     manifest.json      what was executed, and under which versions
 *     dataset.jsonl      snapshot of the cases the run used
 *     results.jsonl      one CaseResult per case; written once, never edited
 *     evaluations.jsonl  one EvaluationRecord per case × evaluator; recomputable
 *
 * These files are the contract between the runner, the evaluators, the CLI and
 * any later interface. Each record is defined once here as a runtime schema and
 * its TypeScript type is inferred from it. Objects are strict: an unknown field
 * means the record was written by a different version, not that it can be dropped.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonSchema: z.ZodType<JsonValue> = z.json();
const id = z.string().min(1);
/** Identifiers that end up in directory names and on the command line. */
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

// --- Trace -----------------------------------------------------------------

const eventBase = {
  /** Position within the case, assigned by the lab. */
  seq: z.number().int().nonnegative(),
  /**
   * "observed": the lab saw it happen (a call through a lab-owned tool).
   * "reported": the candidate said it happened. Weaker evidence.
   */
  source: z.enum(["observed", "reported"]),
};

export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const traceEventSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      ...eventBase,
      type: z.literal("tool_call"),
      name: id,
      args: jsonSchema,
      /** Absent when the call failed, or had not returned by the time the case ended. */
      result: jsonSchema.optional(),
      /** Present when the call failed. A failed call is not a failed case: the candidate may recover. */
      error: z.string().optional(),
      durationMs: z.number().nonnegative().optional(),
    })
    .refine((e) => e.result === undefined || e.error === undefined, {
      message: "a tool call has a result or an error, not both",
    }),
  z.strictObject({
    ...eventBase,
    type: z.literal("model_call"),
    model: id,
    usage: usageSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("fallback"),
    from: id,
    to: id,
    reason: z.string(),
  }),
]);

// --- Results ---------------------------------------------------------------

export const candidateOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), value: jsonSchema }),
  z.strictObject({ kind: z.literal("abstain"), reason: z.string() }),
]);

/** Fields every result ends with. Records are written in schema order, so a line reads: case, how it ended, evidence. */
const observed = {
  /** Wall-clock time of the candidate call, measured by the lab. */
  durationMs: z.number().nonnegative(),
  trace: z.array(traceEventSchema),
};

/**
 * What a candidate observably did on one case. The status says how execution
 * ended; whether a completed output is any good is for evaluators to decide.
 */
export const caseResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    caseId: id,
    status: z.literal("completed"),
    output: candidateOutputSchema,
    ...observed,
  }),
  z.strictObject({
    caseId: id,
    status: z.literal("malformed_output"),
    /** Why the output was rejected. */
    problem: z.string(),
    /** What the candidate returned, when it can be represented as JSON. */
    rawOutput: jsonSchema.optional(),
    ...observed,
  }),
  z.strictObject({
    caseId: id,
    status: z.literal("error"),
    error: z.strictObject({ message: z.string(), stack: z.string().optional() }),
    ...observed,
  }),
  z.strictObject({
    caseId: id,
    status: z.literal("timeout"),
    timeoutMs: z.number().positive(),
    ...observed,
  }),
]);

// --- Evaluations -----------------------------------------------------------

const decided = z.strictObject({
  outcome: z.enum(["pass", "fail"]),
  /** A number behind the judgment, e.g. a count of unnecessary tool calls. */
  value: z.number().optional(),
  detail: z.string().optional(),
});
const undecided = z.strictObject({
  /** "error" means the evaluator itself failed; it says nothing about the candidate. */
  outcome: z.enum(["not_applicable", "error"]),
  detail: z.string().min(1),
});

/** What an evaluator may conclude about a completed case. */
export const judgmentSchema = z.discriminatedUnion("outcome", [decided, undecided]);

/**
 * A judgment, or the fact that there is none: a case that did not complete
 * never reaches an evaluator and is recorded as not_evaluated. It is not a pass.
 */
export const verdictSchema = z.discriminatedUnion("outcome", [
  decided,
  undecided,
  z.strictObject({ outcome: z.literal("not_evaluated"), detail: z.string().min(1) }),
]);

export const evaluationRecordSchema = z.strictObject({
  caseId: id,
  evaluator: z.strictObject({ id: slug, version: id }),
  verdict: verdictSchema,
});

// --- Dataset and manifest --------------------------------------------------

export const datasetCaseSchema = z.strictObject({
  id,
  input: jsonSchema,
  expected: jsonSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: slug,
  scenario: z.strictObject({ id: slug, version: id }),
  dataset: z.strictObject({
    name: slug,
    /** Hash of dataset.jsonl as snapshotted into the run. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    caseCount: z.number().int().nonnegative(),
  }),
  candidate: z.strictObject({
    id: slug,
    version: id,
    config: jsonSchema,
    /** Declared by the candidate. When false, a single run is one sample, not the answer. */
    deterministic: z.boolean(),
  }),
  settings: z.strictObject({ timeoutMs: z.number().positive() }),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  environment: z.strictObject({
    node: z.string(),
    platform: z.string(),
    /** null when the lab was not run from a git checkout. */
    git: z.strictObject({ commit: id, dirty: z.boolean() }).nullable(),
  }),
});

export type Usage = z.infer<typeof usageSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type CaseResult = z.infer<typeof caseResultSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;
export type DatasetCase = z.infer<typeof datasetCaseSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
