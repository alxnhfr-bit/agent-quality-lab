import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { evaluateRun, toolRecordOf } from "./evaluate.ts";
import { importRun, type ImportedAnswers } from "./import.ts";
import { MIN_RUNS, overview } from "./overview.ts";
import { parseDataset } from "./store.ts";
import type { RunData } from "./compare.ts";
import type { Evaluator } from "./types.ts";

type Label = { label: "a" | "b" };

const outputSchema = z.strictObject({ label: z.enum(["a", "b"]) });
const sorts: Evaluator<string, Label, Label> = {
  id: "sorts",
  version: "1",
  evaluate: (c, { output }) =>
    output.kind === "answer" && output.value.label === c.expected!.label ? { outcome: "pass" } : { outcome: "fail" },
};
const scenario = { id: "sorting", version: "1", inputSchema: z.string(), outputSchema, expectedSchema: outputSchema, evaluators: [sorts] };
// Ten cases, every one labelled a; the first two are tagged easy.
const dataset = parseDataset(
  scenario,
  "dev",
  Array.from({ length: 10 }, (_, i) => `${JSON.stringify({ id: `c${i}`, input: `case ${i}`, expected: { label: "a" }, ...(i < 2 && { tags: ["easy"] }) })}\n`).join(""),
);
const environment = { node: "v24.0.0", platform: "test", git: null };

let minute = 0;
/** One run of a system that gets `right` of the ten cases right; `missing` cases end in an error. */
async function run(system: string, right: number, options: { missing?: number; config?: object; data?: typeof dataset } = {}): Promise<RunData> {
  const data = options.data ?? dataset;
  const answers: ImportedAnswers["answers"] = data.cases.map((c, i) =>
    i < (options.missing ?? 0) ? { caseId: c.id, error: "no answer recorded" } : { caseId: c.id, answer: { label: i < right ? "a" : "b" } },
  );
  const imported: ImportedAnswers = {
    candidate: { id: system, version: "1", config: options.config ?? { model: "m" } },
    startedAt: new Date(Date.UTC(2026, 9, 20, 9, minute++)).toISOString(),
    answers,
  };
  const made = importRun(scenario, data, imported, { source: `${system}.json`, sha256: "c".repeat(64), environment });
  const evaluations = await evaluateRun(scenario, data.cases, made.results, toolRecordOf(made.manifest));
  return { manifest: made.manifest, cases: JSON.parse(`[${data.text.trim().split("\n").join(",")}]`), results: made.results, evaluations };
}

test("runs of one system are recognised as repeats, and each check becomes a range over them", async () => {
  const o = overview([await run("steady", 9), await run("steady", 7), await run("steady", 8), await run("once", 5)]);

  assert.deepEqual(o.systems.map((s) => [s.name, s.runIds.length]), [["steady", 3], ["once", 1]]);
  const steady = o.systems[0]!;
  assert.deepEqual(steady.checks.sorts, {
    runs: [
      { pass: 9, of: 10, unanswered: 0 },
      { pass: 7, of: 10, unanswered: 0 },
      { pass: 8, of: 10, unanswered: 0 },
    ],
    low: 0.7,
    high: 0.9,
    unanswered: false,
  });
  assert.deepEqual(o.tags, [{ tag: "easy", cases: 2 }]);
  assert.deepEqual([steady.byTag.easy!.sorts!.low, steady.byTag.easy!.sorts!.high], [1, 1]);
  assert.equal(o.systems[1]!.steadiness, undefined, "one run says nothing about steadiness");
});

test("a run with different settings is a different system, even under the same name", async () => {
  const o = overview([await run("model", 9), await run("model", 9, { config: { model: "bigger" } })]);
  assert.deepEqual(o.systems.map((s) => s.name), ["model 1", "model 1 (2)"]);
});

test("steadiness separates the cases a system gets wrong every time from those it varies on", async () => {
  // Case c7 is right in two runs of three; c8 and c9 are wrong every time.
  const o = overview([await run("steady", 8), await run("steady", 7), await run("steady", 8)]);
  assert.deepEqual(o.systems[0]!.steadiness!.sorts, {
    passedEveryTime: ["c0", "c1", "c2", "c3", "c4", "c5", "c6"],
    failedEveryTime: ["c8", "c9"],
    varied: [{ caseId: "c7", passed: 2, of: 3 }],
    unanswered: [],
  });

  // A missing answer is not a change of mind: such a case is listed apart.
  const gaps = overview([await run("gappy", 9, { missing: 1 }), await run("gappy", 9)]);
  assert.deepEqual(gaps.systems[0]!.steadiness!.sorts!.unanswered, ["c0"]);
  assert.deepEqual(gaps.systems[0]!.steadiness!.sorts!.varied, []);
  assert.equal(gaps.systems[0]!.answered, false);
  assert.equal(gaps.systems[0]!.checks.sorts!.unanswered, true);
  assert.deepEqual(gaps.systems[0]!.checks.sorts!.runs[0], { pass: 8, of: 9, unanswered: 1 });
});

test(`a difference is called only between systems with ${MIN_RUNS} answered runs each whose ranges lie apart`, async () => {
  const strong = [await run("strong", 10), await run("strong", 9), await run("strong", 10)];
  const weak = [await run("weak", 6), await run("weak", 7), await run("weak", 6)];
  const close = [await run("close", 9), await run("close", 8), await run("close", 8)];

  const apart = overview([...strong, ...weak, ...close]);
  assert.deepEqual(apart.eligible, ["close", "strong", "weak"]);
  assert.deepEqual(apart.differences, [
    { check: "sorts", higher: "close", lower: "weak" },
    { check: "sorts", higher: "strong", lower: "weak" },
  ]);
  assert.deepEqual(apart.overlaps, [{ a: "close", b: "strong", check: "sorts" }]);

  // Too few runs, or a run with an answer missing, and nothing is called.
  const few = overview([...strong, await run("weak", 1), await run("weak", 1)]);
  assert.deepEqual([few.eligible, few.differences], [["strong"], []]);
  const gappy = overview([...strong, ...weak.slice(0, 2), await run("weak", 6, { missing: 1 })]);
  assert.deepEqual([gappy.eligible, gappy.differences], [["strong"], []]);
});

test("runs that cannot be counted are left out, and say why", async () => {
  const unscored = { ...(await run("lazy", 9)), evaluations: null };
  const changed = parseDataset(scenario, "dev", dataset.text.replace('"case 0"', '"case zero"'));
  const older = await run("old", 9, { data: changed });
  const kept = await run("kept", 9);

  const o = overview([older, unscored, kept]);
  assert.deepEqual(o.systems.map((s) => s.name), ["kept"]);
  assert.deepEqual(
    o.leftOut.map(({ runId, reason }) => [runId.split("_").at(-1), reason]),
    // Oldest first, as the runs were made.
    [
      ["lazy", `${unscored.manifest.runId} has not been scored: run "aql eval ${unscored.manifest.runId}"`],
      ["old", "it ran on an earlier version of the dataset"],
    ],
  );
  assert.throws(() => overview([]), /no runs to give an overview of/);
});
