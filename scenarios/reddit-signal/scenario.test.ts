import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRun, importRun, toolRecordOf, type EvaluationRecord, type ImportedAnswers } from "@agent-quality-lab/core";
import { parseDataset } from "@agent-quality-lab/core/store";
import {
  answersFromPredictions,
  answersFromResults,
  camundaCorrections,
  camundaLookups,
  datasetFromLabels,
  mcpLookups,
  parseCsv,
  startOf,
  type StoredPost,
} from "./prepare.ts";
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
    evaluations.filter(({ evaluator }) => evaluator.id === "label").map(({ caseId, verdict }) => [caseId, verdict]),
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
  const [abstained] = (await evaluateRun(scenario, dataset.cases, run.results)).filter(({ evaluator }) => evaluator.id === "label");
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
  const imported = answersFromResults(`${jsonl}\n`, candidate, { startedAt: "2026-07-23T18:26:12Z" });

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

// --- The place check ------------------------------------------------------------------

const INNSBRUCK = { placeName: "Innsbruck", canonicalName: "Innsbruck", placeId: "place-1" };

/** Three posts as a runner recorded them: p1 labelled rising, p2 (should be no_signal) and p3 as given. */
function stored(p2: Partial<StoredPost>, p1: Partial<StoredPost> = {}): string {
  return [
    { post_id: "p1", predicted: "rising_destinations", toolCalls: 1, groundedPlaces: [INNSBRUCK], ...p1 },
    { post_id: "p2", predicted: "no_signal", toolCalls: 0, groundedPlaces: [], ...p2 },
    { post_id: "p3", predicted: "planning_pain_points", toolCalls: 0, groundedPlaces: [] },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}

async function verdicts(imported: ImportedAnswers): Promise<Record<string, Record<string, string>>> {
  const run = importRun(scenario, dataset, imported, options);
  const records: EvaluationRecord[] = await evaluateRun(scenario, dataset.cases, run.results, toolRecordOf(run.manifest));
  const byCheck: Record<string, Record<string, string>> = {};
  for (const { caseId, evaluator, verdict } of records) {
    if (evaluator.id === "label") continue;
    byCheck[evaluator.id] ??= {};
    byCheck[evaluator.id]![caseId] = verdict.outcome === "fail" || verdict.outcome === "not_applicable" ? `${verdict.outcome}: ${verdict.detail}` : verdict.outcome;
  }
  return byCheck;
}

const tools = [{ name: "verify_place" }];

test("a rising destination needs a confirmed place, and a post with nothing in it needs no lookup", async () => {
  const sloppy = stored(
    { toolCalls: 1, groundedPlaces: [], toolTrace: [{ query: { placeName: "Sedona" }, found: true, canonicalName: "Sedona", placeId: "place-2" }] } as Partial<StoredPost>,
    { toolCalls: 1, toolTrace: [{ query: { placeName: "Atlantis" }, found: false }] } as Partial<StoredPost>,
  );
  assert.deepEqual(await verdicts(answersFromResults(sloppy, candidate, { tools, lookups: mcpLookups })), {
    verified: {
      p1: "fail: labelled rising_destinations without a confirmed place",
      p2: "not_applicable: only a post labelled rising_destinations needs a confirmed place",
      p3: "not_applicable: only a post labelled rising_destinations needs a confirmed place",
    },
    restraint: {
      p1: "not_applicable: only a post that should be no_signal must get no lookup",
      p2: "fail: looked up a place on a post with nothing in it: Sedona",
      p3: "not_applicable: only a post that should be no_signal must get no lookup",
    },
  });
});

test("Camunda's record, the places it confirmed, is enough for both rules", async () => {
  const careful = answersFromResults(stored({}), candidate, { tools, lookups: camundaLookups });
  assert.deepEqual(careful.answers[0]!.toolCalls, [{ name: "verify_place", args: null, result: { found: true, ...INNSBRUCK } }]);
  const result = await verdicts(careful);
  assert.equal(result.verified!.p1, "pass");
  assert.equal(result.restraint!.p2, "pass");

  // A lookup that confirmed nothing is still a lookup, though what it asked was not recorded.
  const extra = answersFromResults(stored({ toolCalls: 1 }), candidate, { tools, lookups: camundaLookups });
  assert.deepEqual(extra.answers[1]!.toolCalls, [{ name: "verify_place", args: null }]);
  assert.equal((await verdicts(extra)).restraint!.p2, "fail: looked up a place on a post with nothing in it");

  // A confirmed place carries an id only a lookup returns, so it counts as one even where the count missed it, and says so.
  const missed = { post_id: "p9", toolCalls: 0, groundedPlaces: [INNSBRUCK] };
  assert.deepEqual(camundaLookups(missed), [{ name: "verify_place", args: null, result: { found: true, ...INNSBRUCK } }]);
  assert.deepEqual(camundaCorrections(`${JSON.stringify(missed)}\n${stored({})}`), [
    "p9: 1 confirmed place(s) but 0 lookup(s) counted; taken as one lookup per confirmed place",
  ]);
  assert.throws(() => mcpLookups({ post_id: "p9", toolCalls: 2, toolTrace: [] }), /2 tool calls counted, but 0 recorded/);
});

test("the place rules do not judge a system that had no place check, or whose lookups were not recorded", async () => {
  const none = await verdicts({ ...answersFromResults(stored({}), candidate), tools: [] });
  assert.deepEqual(new Set(Object.values(none).flatMap(Object.values)), new Set(["not_applicable: this system had no place check"]));

  const unrecorded = await verdicts(answersFromResults(stored({}), candidate));
  assert.deepEqual(new Set(Object.values(unrecorded).flatMap(Object.values)), new Set(["not_applicable: the run did not record its tool calls"]));
});
