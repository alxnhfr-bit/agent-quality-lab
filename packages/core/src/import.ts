/**
 * Turns answers that were produced outside the lab into a run, so they can be
 * scored and compared like any other run. The lab did not watch them being
 * made, and the run says so: it records where the answers came from, no
 * durations, no settings and no instructions, and only what the source recorded.
 *
 * Answers are checked exactly as the runner checks a candidate's: one that
 * does not fit the scenario's output schema is malformed output, never
 * quietly mapped onto something that fits.
 */
import { z } from "zod";
import { SCHEMA_VERSION, jsonSchema, manifestSchema, type CaseResult, type Manifest } from "./artifact.ts";
import { resultOf, runIdFor, type Run } from "./runner.ts";
import type { Dataset, Scenario } from "./types.ts";

const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** One case's answer as the source recorded it: an answer, an abstention, or the error it ended with. */
const importedAnswerSchema = z.union([
  z.strictObject({ caseId: z.string().min(1), answer: jsonSchema }),
  z.strictObject({ caseId: z.string().min(1), abstain: z.string() }),
  z.strictObject({ caseId: z.string().min(1), error: z.string().min(1) }),
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
  const { candidate, startedAt, answers } = importedAnswersSchema.parse(imported);
  const now = options.now ?? (() => new Date());

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
    const base = { caseId: c.id, trace: [] };
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
    origin: { kind: "imported", source: options.source, sha256: options.sha256 },
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    environment: options.environment,
  });
  return { manifest, results };
}

function list(ids: string[]): string {
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} and ${ids.length - 5} more`;
}
