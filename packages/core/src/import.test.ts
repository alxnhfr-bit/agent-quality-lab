import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { manifestSchema } from "./artifact.ts";
import { comparability } from "./compare.ts";
import { evaluateRun } from "./evaluate.ts";
import { importRun, type ImportedAnswers } from "./import.ts";
import { parseDataset } from "./store.ts";
import { summarize } from "./summary.ts";
import type { Evaluator } from "./types.ts";

type Label = { label: "a" | "b" };

const outputSchema = z.strictObject({ label: z.enum(["a", "b"]) });
const sorts: Evaluator<string, Label, Label> = {
  id: "sorts",
  version: "1",
  evaluate: (c, { output }) => {
    if (output.kind === "abstain") return { outcome: "fail", detail: "abstained" };
    return {
      outcome: output.value.label === c.expected!.label ? "pass" : "fail",
      label: { expected: c.expected!.label, actual: output.value.label },
    };
  },
};
const scenario = {
  id: "sorting",
  version: "1",
  inputSchema: z.string(),
  outputSchema,
  expectedSchema: outputSchema,
  evaluators: [sorts],
};
const dataset = parseDataset(
  scenario,
  "dev",
  ["one", "two", "three", "four"].map((input, i) => `${JSON.stringify({ id: `c${i + 1}`, input, expected: { label: i < 2 ? "a" : "b" } })}\n`).join(""),
);
const environment = { node: "v24.0.0", platform: "test", git: null };
const options = { source: "elsewhere/answers.json", sha256: "a".repeat(64), environment, now: () => new Date("2026-10-19T09:00:00.000Z") };
const candidate = { id: "elsewhere", version: "run-7", config: { model: "some-model", reads: "the title only" } };

const answers = (...given: ImportedAnswers["answers"]): ImportedAnswers => ({ candidate, answers: given });

test("answers made elsewhere become a run that says where they came from and claims nothing the lab did not see", () => {
  const run = importRun(
    scenario,
    dataset,
    { ...answers({ caseId: "c1", answer: { label: "a" } }, { caseId: "c2", answer: { label: "b" } }, { caseId: "c3", abstain: "not sure" }, { caseId: "c4", answer: { label: "b" } }), startedAt: "2026-08-07T10:25:17.085Z" },
    options,
  );

  assert.deepEqual(run.manifest, {
    schemaVersion: 1,
    runId: "2026-08-07T10-25-17Z_sorting_elsewhere",
    scenario: { id: "sorting", version: "1" },
    dataset: { name: "dev", sha256: dataset.sha256, caseCount: 4 },
    candidate: { ...candidate, deterministic: false },
    origin: { kind: "imported", source: "elsewhere/answers.json", sha256: "a".repeat(64) },
    startedAt: "2026-08-07T10:25:17.085Z",
    finishedAt: "2026-10-19T09:00:00.000Z",
    environment,
  });
  assert.ok(manifestSchema.safeParse(run.manifest).success);
  assert.deepEqual(run.results, [
    { caseId: "c1", status: "completed", output: { kind: "answer", value: { label: "a" } }, trace: [] },
    { caseId: "c2", status: "completed", output: { kind: "answer", value: { label: "b" } }, trace: [] },
    { caseId: "c3", status: "completed", output: { kind: "abstain", reason: "not sure" }, trace: [] },
    { caseId: "c4", status: "completed", output: { kind: "answer", value: { label: "b" } }, trace: [] },
  ]);
  assert.equal(summarize(run.results, []).durationMs, null, "no duration is made up");
});

test("an answer that does not fit is malformed output, never mapped onto a label that fits", () => {
  const run = importRun(
    scenario,
    dataset,
    answers(
      { caseId: "c1", answer: { label: "steady" } },
      { caseId: "c2", answer: "a" },
      { caseId: "c3", error: "the request timed out" },
      { caseId: "c4", answer: { label: "b" } },
    ),
    options,
  );
  const [invented, unshaped, failed] = run.results;

  assert.equal(invented!.status, "malformed_output");
  assert.deepEqual(invented!.status === "malformed_output" && invented!.rawOutput, { kind: "answer", value: { label: "steady" } });
  assert.equal(unshaped!.status, "malformed_output");
  assert.deepEqual(failed, { caseId: "c3", status: "error", error: { message: "the request timed out" }, trace: [] });
  // Without a known start, the run is named after the moment it was imported.
  assert.equal(run.manifest.runId, "2026-10-19T09-00-00Z_sorting_elsewhere");
});

test("a partial, doubled or stray set of answers is refused, not stored as a run that stopped early", () => {
  const all = ["c1", "c2", "c3", "c4"].map((caseId) => ({ caseId, answer: { label: "a" } }));

  assert.throws(() => importRun(scenario, dataset, answers(...all.slice(0, 2)), options), /the answers cover 2 of the 4 cases; missing: c3, c4/);
  assert.throws(() => importRun(scenario, dataset, answers(...all, all[0]!), options), /more than one answer for case "c1"/);
  assert.throws(
    () => importRun(scenario, dataset, answers(...all, { caseId: "c9", answer: { label: "a" } }), options),
    /answers for cases not in dataset "dev": c9/,
  );
  assert.throws(() => importRun(scenario, dataset, { ...answers(...all), candidate: { ...candidate, id: "no spaces" } }, options));
});

test("an imported run is scored like any other, and two imports of the same dataset can be compared", async () => {
  const first = importRun(scenario, dataset, answers(...["a", "a", "a", "b"].map((label, i) => ({ caseId: `c${i + 1}`, answer: { label } }))), options);
  const second = importRun(
    scenario,
    dataset,
    { ...answers(...["a", "b", "b", "b"].map((label, i) => ({ caseId: `c${i + 1}`, answer: { label } }))), startedAt: "2026-08-07T10:00:00.000Z" },
    options,
  );
  const evaluations = await evaluateRun(scenario, dataset.cases, first.results);

  assert.deepEqual(
    evaluations.map(({ caseId, verdict }) => [caseId, verdict.outcome]),
    [["c1", "pass"], ["c2", "pass"], ["c3", "fail"], ["c4", "pass"]],
  );
  const runData = (run: typeof first) => ({ manifest: run.manifest, cases: JSON.parse(`[${dataset.text.trim().split("\n").join(",")}]`), results: run.results, evaluations });
  assert.deepEqual(comparability(runData(first), runData(second)), []);
});
