import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { manifestSchema } from "./artifact.ts";
import { comparability } from "./compare.ts";
import { evaluateRun, toolRecordOf } from "./evaluate.ts";
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

test("tool calls come along when the file says which tools the system had, recorded as reported by the source", () => {
  const lookup = { name: "lookup", args: { q: "one" }, result: { found: true }, durationMs: 12 };
  type Calls = ImportedAnswers["answers"][number]["toolCalls"];
  const withTools = (toolCalls: Calls, tools: { name: string }[] | null = [{ name: "lookup" }]) => ({
    candidate,
    ...(tools && { tools }),
    answers: ["c1", "c2", "c3", "c4"].map((caseId, i) => ({ caseId, answer: { label: "a" }, ...(toolCalls && { toolCalls: i === 0 ? toolCalls : [] }) })),
  });

  const run = importRun(scenario, dataset, withTools([lookup, { name: "lookup", args: null }]), options);
  assert.deepEqual(run.results[0]!.trace, [
    { seq: 0, source: "reported", type: "tool_call", name: "lookup", args: { q: "one" }, result: { found: true }, durationMs: 12 },
    { seq: 1, source: "reported", type: "tool_call", name: "lookup", args: null },
  ]);
  assert.deepEqual(run.manifest.origin?.tools, [{ name: "lookup" }]);
  assert.deepEqual(toolRecordOf(run.manifest), { calls: true, tools: ["lookup"] });

  // A system without tools brings no calls, and one without a word on its tools brings no evidence about them.
  assert.deepEqual(toolRecordOf(importRun(scenario, dataset, withTools(undefined, []), options).manifest), { calls: true, tools: [] });
  assert.deepEqual(toolRecordOf(importRun(scenario, dataset, withTools(undefined, null), options).manifest), { calls: false });

  assert.throws(() => importRun(scenario, dataset, withTools([lookup], null), options), /lists tool calls, but the file does not say which tools the system had/);
  assert.throws(() => importRun(scenario, dataset, withTools(undefined), options), /brings no tool calls, though the system had tools/);
  assert.throws(() => importRun(scenario, dataset, withTools([{ ...lookup, name: "search" }]), options), /calls "search", which is not among the system's tools/);
});

test("a check that reads tool calls does not judge a run whose tool calls were not recorded", async () => {
  const seen: (readonly string[] | undefined)[] = [];
  const looked: Evaluator<string, Label, Label> = {
    id: "looked",
    version: "1",
    readsToolCalls: true,
    evaluate: (_c, { trace, tools }) => {
      seen.push(tools);
      return { outcome: trace.length > 0 ? "pass" : "fail" };
    },
  };
  const checks = { ...scenario, evaluators: [sorts, looked] };
  const all = (extra: object) => ["c1", "c2", "c3", "c4"].map((caseId) => ({ caseId, answer: { label: "a" }, ...extra }));
  const outcomes = async (imported: ImportedAnswers) => {
    const run = importRun(checks, dataset, imported, options);
    const records = await evaluateRun(checks, dataset.cases, run.results, toolRecordOf(run.manifest));
    return records.filter(({ evaluator }) => evaluator.id === "looked").map(({ verdict }) => verdict.outcome === "not_applicable" ? verdict.detail : verdict.outcome);
  };

  assert.deepEqual(await outcomes({ candidate, answers: all({}) }), Array(4).fill("the run did not record its tool calls"));
  assert.deepEqual(seen, [], "the check is not asked at all");
  assert.deepEqual(await outcomes({ candidate, tools: [{ name: "lookup" }], answers: all({ toolCalls: [] }) }), Array(4).fill("fail"));
  assert.deepEqual(seen, Array(4).fill(["lookup"]));
});

test("a run the lab made has its tool calls, and the tools its scenario offered", () => {
  const made = manifestSchema.parse({
    schemaVersion: 1,
    runId: "2026-10-19T09-00-00Z_sorting_program",
    scenario: { id: "sorting", version: "1", instructions: "", tools: [{ name: "lookup", description: "Looks up.", parameters: {} }] },
    dataset: { name: "dev", sha256: dataset.sha256, caseCount: 4 },
    candidate: { id: "program", version: "1", config: null, deterministic: true },
    settings: { timeoutMs: 100 },
    startedAt: "2026-10-19T09:00:00.000Z",
    environment,
  });
  assert.deepEqual(toolRecordOf(made), { calls: true, tools: ["lookup"] });
  const { tools: _, ...older } = made.scenario;
  assert.deepEqual(toolRecordOf({ ...made, scenario: older }), { calls: true });
});
