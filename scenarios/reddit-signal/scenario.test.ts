import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRun, importRun } from "@agent-quality-lab/core";
import { parseDataset } from "@agent-quality-lab/core/store";
import { answersFromPredictions, answersFromResults, datasetFromLabels, parseCsv, startOf } from "./prepare.ts";
import scenario from "./scenario.ts";

// Made-up posts in the projects' file formats. The real ones are not part of this repository.
const LABELS_CSV = [
  "post_id,subreddit,post_title,post_url,upvotes,comment_count,true_bucket,in_rubric",
  'p1,travel,"Two weeks in Ljubljana, Slovenia",https://reddit.com/r/travel/comments/p1/,120,14,rising_destinations,True',
  'p2,solotravel,"What did you pack and never use? ""Nothing"" is not an answer",https://reddit.com/r/solotravel/comments/p2/,85,40,no_signal,False',
  "p3,JapanTravel,Ryokan with a private onsen?,https://reddit.com/r/JapanTravel/comments/p3/,12,3,planning_pain_points,false",
  "",
].join("\r\n");

const dataset = parseDataset(scenario, "labels", datasetFromLabels(LABELS_CSV));
const environment = { node: "v24.0.0", platform: "test", git: null };
const options = { source: "imports/test.json", sha256: "b".repeat(64), environment };
const candidate = { id: "test-system", version: "1", config: { model: "none" } };

test("CSV is read as the projects write it: quotes, doubled quotes, commas inside quotes and Windows line ends", () => {
  assert.deepEqual(parseCsv('a,b,c\n"x, y","say ""hi""",\n"multi\nline",2,3\n'), [
    { a: "x, y", b: 'say "hi"', c: "" },
    { a: "multi\nline", b: "2", c: "3" },
  ]);
  assert.throws(() => parseCsv('a,b\n"open,1\n'), /ends inside a quoted field/);
  assert.throws(() => parseCsv("a,b\n1,2,3\n"), /row 2 has 3 fields where the header has 2/);
});

test("each labelled post becomes a case, tagged by whether the rubric quotes it", () => {
  assert.deepEqual(
    dataset.cases.map((c) => [c.id, c.input.title, c.input.upvotes, c.expected?.label, c.tags]),
    [
      ["p1", "Two weeks in Ljubljana, Slovenia", 120, "rising_destinations", ["in-rubric"]],
      ["p2", 'What did you pack and never use? "Nothing" is not an answer', 85, "no_signal", ["held-out"]],
      ["p3", "Ryokan with a private onsen?", 12, "planning_pain_points", ["held-out"]],
    ],
  );
  assert.throws(() => datasetFromLabels(LABELS_CSV.replace("True", "yes")), /post p1: in_rubric is "yes"/);
  assert.throws(() => datasetFromLabels(LABELS_CSV.replace(",120,", ",many,")), /post p1: upvotes is "many"/);
  assert.throws(() => parseDataset(scenario, "labels", datasetFromLabels(LABELS_CSV.replace("no_signal", "steady_baseline"))));
});

test("a post scores when it gets its label, and every verdict says which label it got", async () => {
  const run = importRun(
    scenario,
    dataset,
    answersFromPredictions("post_id,bucket\np1,rising_destinations\np2,planning_pain_points\np3,steady_baseline\n", candidate),
    options,
  );
  const evaluations = await evaluateRun(scenario, dataset.cases, run.results);

  assert.deepEqual(
    evaluations.map(({ caseId, verdict }) => [caseId, verdict]),
    [
      ["p1", { outcome: "pass", label: { expected: "rising_destinations", actual: "rising_destinations" } }],
      [
        "p2",
        {
          outcome: "fail",
          label: { expected: "no_signal", actual: "planning_pain_points" },
          detail: "labelled planning_pain_points, should be no_signal",
        },
      ],
      // A label outside the five is not quietly read as no_signal: the answer is malformed, and counts as wrong.
      ["p3", { outcome: "not_evaluated", detail: "the case did not complete (malformed_output)" }],
    ],
  );
});

test("an abstention is wrong, since no_signal is the label for a post with nothing in it", async () => {
  const run = importRun(
    scenario,
    dataset,
    { candidate, answers: [{ caseId: "p1", abstain: "unsure" }, { caseId: "p2", answer: { label: "no_signal" } }, { caseId: "p3", answer: { label: "no_signal" } }] },
    options,
  );
  const [abstained] = await evaluateRun(scenario, dataset.cases, run.results);
  assert.equal(abstained!.verdict.outcome, "fail");
});

test("a stored run's answers come across as recorded, and a post with no recorded label becomes an error", () => {
  const jsonl = [
    { post_id: "p1", predicted: "rising_destinations", error: null, toolCalls: 1 },
    { post_id: "p2", predicted: null, error: null },
    { post_id: "p3", predicted: null, error: "Connector failed: quota exceeded" },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  const imported = answersFromResults(`${jsonl}\n`, candidate, "2026-07-23T18:26:12Z");

  assert.deepEqual(imported, {
    candidate,
    startedAt: "2026-07-23T18:26:12Z",
    answers: [
      { caseId: "p1", answer: { label: "rising_destinations" } },
      { caseId: "p2", error: "the run recorded no label for this post" },
      { caseId: "p3", error: "Connector failed: quota exceeded" },
    ],
  });
  assert.deepEqual(
    importRun(scenario, dataset, imported, options).results.map((result) => result.status),
    ["completed", "error", "error"],
  );
});

test("a run folder's name gives the moment the run started", () => {
  assert.equal(startOf("run-2026-07-23T18-26-12"), "2026-07-23T18:26:12Z");
  assert.equal(startOf("run-2026-08-07T10-27-58-armB-run1"), "2026-08-07T10:27:58Z");
  assert.equal(startOf("results"), undefined);
});
