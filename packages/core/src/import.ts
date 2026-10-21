/**
 * Turns answers that were produced outside the lab into a run, so they can be
 * scored and compared like any other run. The lab did not watch them being
 * made, and the run says so: it records where the answers came from, no
 * durations, no settings and no instructions, and only what the source recorded.
 * Tool calls come along when the source says which tools the system had; they
 * are recorded as reported by the source.
 *
 * Answers are checked exactly as the runner checks a candidate's: one that
 * does not fit the scenario's output schema is malformed output, never
 * quietly mapped onto something that fits.
 */
import { z } from "zod";
import {
  SCHEMA_VERSION,
  jsonSchema,
  manifestSchema,
  traceEventSchema,
  type CaseResult,
  type Manifest,
  type TraceEvent,
} from "./artifact.ts";
import { resultOf, runIdFor, type Run } from "./runner.ts";
import type { Dataset, Scenario } from "./types.ts";

const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** A tool call as the source recorded it. It goes into the trace as reported by the source, not seen by the lab. */
const importedToolCallSchema = z
  .strictObject({
    name: z.string().min(1),
    /** null when the source did not record what was asked. */
    args: jsonSchema,
    /** Absent when the call failed, or when the source did not record its answer. */
    result: jsonSchema.optional(),
    error: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  })
  .refine((call) => call.result === undefined || call.error === undefined, {
    message: "a tool call has a result or an error, not both",
  });

const answerBase = {
  caseId: z.string().min(1),
  /** The tool calls made for this case, when the system had tools. An empty list: it made none. */
  toolCalls: z.array(importedToolCallSchema).optional(),
};

/** One case's answer as the source recorded it: an answer, an abstention, or the error it ended with. */
const importedAnswerSchema = z.union([
  z.strictObject({ ...answerBase, answer: jsonSchema }),
  z.strictObject({ ...answerBase, abstain: z.string() }),
  z.strictObject({ ...answerBase, error: z.string().min(1) }),
]);

/** The file an import reads: what produced the answers, and the answers. */
export const importedAnswersSchema = z.strictObject({
  candidate: z.strictObject({
    id: slug,
    version: z.string().min(1),
    /** What the source system was, as far as it is known: model, prompt, how it read a case. */
    config: jsonSchema,
    /** True only if the source gives the same answers every time. Most model-based systems do not. */
    deterministic: z.boolean().default(false),
  }),
  /** When the source run started, if it is known. The run is named after it. */
  startedAt: z.iso.datetime().optional(),
  /**
   * What the source recorded about this one run, such as its own name or file.
   * Kept apart from `candidate`, which says what the system was: repeated runs
   * of one system share a candidate and differ here.
   */
  run: jsonSchema.optional(),
  /**
   * The tools the system could call. Given, every answer brings its tool calls;
   * an empty list means it had none. Left out, its tool calls are not known.
   */
  tools: z.array(z.strictObject({ name: z.string().min(1), description: z.string().optional() })).optional(),
  answers: z.array(importedAnswerSchema),
});

export type ImportedAnswers = z.input<typeof importedAnswersSchema>;

export interface ImportOptions {
  /** The file the answers were read from, as it should be named in the run. */
  source: string;
  sha256: string;
  environment: Manifest["environment"];
  now?: () => Date;
}

export function importRun<I, O, E, S>(
  scenario: Pick<Scenario<I, O, E, S>, "id" | "version" | "outputSchema">,
  dataset: Dataset<I, E, S>,
  imported: ImportedAnswers,
  options: ImportOptions,
): Run {
  const { candidate, startedAt, run, tools, answers } = importedAnswersSchema.parse(imported);
  const now = options.now ?? (() => new Date());

  // Tool calls are evidence only when it is known which tools there were, and every answer says what it called.
  const names = new Set(tools?.map((tool) => tool.name));
  for (const { caseId, toolCalls } of answers) {
    if (tools === undefined && toolCalls !== undefined) {
      throw new Error(`the answer for case "${caseId}" lists tool calls, but the file does not say which tools the system had`);
    }
    if (tools !== undefined && tools.length > 0 && toolCalls === undefined) {
      throw new Error(`the answer for case "${caseId}" brings no tool calls, though the system had tools; an empty list says it made none`);
    }
    const unknown = toolCalls?.find((call) => !names.has(call.name));
    if (unknown) throw new Error(`the answer for case "${caseId}" calls "${unknown.name}", which is not among the system's tools`);
  }

  const byCase = new Map<string, (typeof answers)[number]>();
  for (const answer of answers) {
    if (byCase.has(answer.caseId)) throw new Error(`there is more than one answer for case "${answer.caseId}"`);
    byCase.set(answer.caseId, answer);
  }
  const known = new Set(dataset.cases.map((c) => c.id));
  const unknown = [...byCase.keys()].filter((caseId) => !known.has(caseId));
  if (unknown.length > 0) throw new Error(`there are answers for cases not in dataset "${dataset.name}": ${list(unknown)}`);
  // A partial import would look like a run that stopped early; it is refused instead.
  const missing = dataset.cases.filter((c) => !byCase.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    throw new Error(`the answers cover ${byCase.size} of the ${dataset.cases.length} cases; missing: ${list(missing)}`);
  }

  const results = dataset.cases.map((c): CaseResult => {
    const answer = byCase.get(c.id)!;
    const trace = (answer.toolCalls ?? []).map(
      (call, seq): TraceEvent => traceEventSchema.parse({ seq, source: "reported", type: "tool_call", ...call }),
    );
    const base = { caseId: c.id, trace };
    if ("error" in answer) return { ...base, status: "error", error: { message: answer.error } };
    const returned = "answer" in answer ? { kind: "answer", value: answer.answer } : { kind: "abstain", reason: answer.abstain };
    return resultOf(scenario.outputSchema, base, returned);
  });

  const started = startedAt ? new Date(startedAt) : now();
  const manifest = manifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: runIdFor(started, scenario.id, candidate.id),
    // No instructions and no tools: the lab told the source system nothing.
    scenario: { id: scenario.id, version: scenario.version },
    dataset: { name: dataset.name, sha256: dataset.sha256, caseCount: dataset.cases.length },
    candidate,
    origin: {
      kind: "imported",
      source: options.source,
      sha256: options.sha256,
      ...(tools && { tools }),
      ...(run !== undefined && { run }),
    },
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    environment: options.environment,
  });
  return { manifest, results };
}

function list(ids: string[]): string {
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} and ${ids.length - 5} more`;
}
