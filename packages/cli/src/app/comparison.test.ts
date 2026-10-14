import assert from "node:assert/strict";
import { test } from "node:test";
import { chance, compareResults, differences, inOrder, relatedTo } from "./comparison.ts";
import type { Scorecard, ScoredCase } from "./scorecard.ts";

type Rating = ScoredCase["rating"];

/** A scorecard of a test with one must-have, with one answer per rating given. */
function card(ratings: Rating[], over: Partial<Scorecard> & { version?: string } = {}): Scorecard {
  const { version = "1", ...rest } = over;
  const outcome = { good: "met", "not good": "not met", "not judged": "not judged" } as const;
  const cases = ratings.map(
    (rating, i): ScoredCase => ({
      id: `q${i + 1}`,
      question: `Question ${i + 1}?`,
      ...(i === 0 && { note: "A note" }),
      answer: `Answer ${i + 1} of version ${version}.`,
      rating,
      verdicts: [{ text: "States the fee", mustHave: true, outcome: outcome[rating], reason: "" }],
    }),
  );
  const count = (rating: Rating) => ratings.filter((r) => r === rating).length;
  return {
    runId: `run-${version}`,
    startedAt: "2026-10-08T10:00:00.000Z",
    agent: { id: "helper", name: "Helper", version, model: "claude-haiku-4-5", instructions: "Be brief." },
    test: { id: "questions", name: "Questions", judgeModel: "claude-opus-5-5", judgedBy: ["claude-opus-5-5"], questions: "hash-1" },
    conditions: "120000 ms, c1 0a1b2c3d",
    demo: false,
    total: ratings.length,
    good: count("good"),
    notJudged: count("not judged"),
    criteria: [{ id: "c1", text: "States the fee", mustHave: true, met: count("good"), judged: ratings.length - count("not judged") }],
    agentCost: 0.01,
    judgeCost: 0.02,
    medianSeconds: 1.2,
    cases,
    ...rest,
  };
}

test("each question is sorted by how its answer moved from the first result to the second", () => {
  const a = card(["not good", "good", "good", "not good", "good", "not judged"]);
  const b = card(["good", "not good", "good", "not good", "not judged", "good"], { version: "2" });
  const comparison = compareResults(a, b);

  assert.deepEqual(
    comparison.questions.map((q) => [q.id, q.change]),
    [
      ["q1", "better"],
      ["q2", "worse"],
      ["q3", "good in both"],
      ["q4", "not good in both"],
      // An answer the judge failed on, on either side, is not called better or worse.
      ["q5", "not compared"],
      ["q6", "not compared"],
    ],
  );
  assert.deepEqual(comparison.counts, { worse: 1, better: 1, "not compared": 2, "not good in both": 1, "good in both": 1 });
  assert.deepEqual(comparison.criteria, [
    { text: "States the fee", mustHave: true, a: { met: 3, judged: 5 }, b: { met: 3, judged: 5 } },
  ]);
  const first = comparison.questions[0]!;
  assert.deepEqual([first.question, first.note, first.a.answer, first.b.answer], [
    "Question 1?",
    "A note",
    "Answer 1 of version 1.",
    "Answer 1 of version 2.",
  ]);
});

test("a split of changed answers is weighed against what chance does when both sides are equally good", () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

  close(chance(0, 0), 1);
  close(chance(1, 0), 1);
  close(chance(3, 3), 1);
  close(chance(5, 0), 0.0625);
  close(chance(6, 0), 0.03125);
  close(chance(0, 6), 0.03125);
  close(chance(8, 1), 0.0390625);
  close(chance(7, 1), 0.0703125);
});

test("a difference is called more than chance only when it is one-sided enough", () => {
  const certainty = (first: Rating[], second: Rating[]) => compareResults(card(first), card(second, { version: "2" })).certainty;
  const not = (n: number): Rating[] => Array<Rating>(n).fill("not good");
  const good = (n: number): Rating[] => Array<Rating>(n).fill("good");

  assert.equal(certainty(good(4), good(4)), "no change");
  assert.equal(certainty([...not(1), ...good(4)], good(5)), "could be chance");
  assert.equal(certainty(not(5), good(5)), "could be chance");
  assert.equal(certainty(not(6), good(6)), "more than chance");
  assert.equal(certainty(good(6), not(6)), "more than chance");
  assert.equal(certainty([...not(6), ...good(2)], [...good(6), ...not(2)]), "could be chance");
});

test("two results can be put side by side only when they answered the same questions and were judged the same way", () => {
  const a = card(["good"]);
  const differs = (over: Partial<Scorecard>) => differences(a, { ...card(["good"], { version: "2" }), ...over });

  assert.deepEqual(differs({}), []);
  assert.deepEqual(differs({ agent: { ...a.agent, id: "another", name: "Another" } }), []);
  assert.deepEqual(differs({ demo: true }), ["One of them is a demo run, in which no model was called."]);
  assert.deepEqual(differs({ test: { ...a.test, id: "others", name: "Others" } }), [
    'They are results of two different tests, "Questions" and "Others".',
  ]);
  assert.deepEqual(differs({ test: { ...a.test, questions: "hash-2" } }), [
    "The test's questions or their notes were changed in between.",
  ]);
  assert.deepEqual(differs({ criteria: [{ ...a.criteria[0]!, text: "Names the fee" }] }), [
    "The test's description of a good answer was changed in between.",
  ]);
  // Whether a sentence is a must-have decides which answers count as good.
  assert.deepEqual(differs({ criteria: [{ ...a.criteria[0]!, mustHave: false }] }), [
    "The test's description of a good answer was changed in between.",
  ]);
  assert.deepEqual(differs({ test: { ...a.test, judgeModel: "claude-sonnet-5-5", judgedBy: ["claude-sonnet-5-5"] } }), [
    "They were judged by different models.",
  ]);
  assert.deepEqual(differs({ test: { ...a.test, judgedBy: [] } }), []);
  assert.deepEqual(differs({ conditions: "120000 ms, c1 ffffffff" }), [
    "The lab itself changed in between, so they were not run and judged in the same way.",
  ]);
  assert.deepEqual(differs({ test: { ...a.test, questions: "hash-2", judgeModel: "claude-sonnet-5-5" }, conditions: "other" }), [
    "The test's questions or their notes were changed in between.",
    "They were judged by different models.",
  ]);

  assert.throws(
    () => compareResults(a, { ...card(["good"]), demo: true }),
    /the two results cannot be compared: One of them is a demo run/,
  );
});

test("unless someone chose otherwise, the lower version comes first, and otherwise the earlier run", () => {
  const v1 = card(["good"], { startedAt: "2026-10-09T10:00:00.000Z" });
  const v2 = card(["good"], { version: "2", startedAt: "2026-10-08T10:00:00.000Z" });
  const v10 = card(["good"], { version: "10", startedAt: "2026-10-07T10:00:00.000Z" });
  const ids = (pair: Scorecard[]) => pair.map((c) => c.agent.version);

  assert.deepEqual(ids(inOrder(v2, v1)), ["1", "2"]);
  assert.deepEqual(ids(inOrder(v10, v2)), ["2", "10"]);

  const other = { ...v2, agent: { ...v2.agent, id: "another" } };
  assert.deepEqual(inOrder(v1, other).map((c) => c.agent.id), ["another", "helper"]);
  const rerun = { ...v1, runId: "run-1-again", startedAt: "2026-10-09T11:00:00.000Z" };
  assert.deepEqual(inOrder(rerun, v1).map((c) => c.runId), ["run-1", "run-1-again"]);
});

test("a scorecard leads to the latest result of the version before, and lists every result it can be compared with", () => {
  const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  const v3 = card(["good"], { version: "3", startedAt: at(9) });
  const others = [
    card(["good"], { runId: "v1", startedAt: at(1) }),
    card(["good"], { version: "2", runId: "v2-first", startedAt: at(2) }),
    card(["good"], { version: "2", runId: "v2-second", startedAt: at(3) }),
    card(["good"], { version: "4", runId: "v4", startedAt: at(10) }),
    { ...card(["good"], { runId: "another-agent", startedAt: at(4) }), agent: { ...v3.agent, id: "another" } },
    { ...card(["good"], { version: "2", runId: "a-demo", startedAt: at(5) }), demo: true },
    { ...card(["good"], { version: "2", runId: "another-test", startedAt: at(6) }), test: { ...v3.test, id: "others" } },
    v3,
  ];
  const related = relatedTo(v3, others);

  assert.deepEqual(related.comparable.map((c) => c.runId), ["v4", "another-agent", "v2-second", "v2-first", "v1"]);
  assert.equal(related.previous?.runId, "v2-second");
  assert.equal(related.outdated, undefined);
});

test("when the version before was tested on an earlier form of the test, the scorecard says why the two cannot be compared", () => {
  const v2 = card(["good"], { version: "2", startedAt: "2026-10-09T10:00:00.000Z" });
  const before = { ...card(["good"], { runId: "v1-old-test" }), test: { ...v2.test, questions: "hash-0" } };
  const related = relatedTo(v2, [before, { ...before, runId: "a-demo", demo: true }, v2]);

  assert.deepEqual(related.comparable, []);
  assert.equal(related.previous, undefined);
  assert.equal(related.outdated?.card.runId, "v1-old-test");
  assert.deepEqual(related.outdated?.reasons, ["The test's questions or their notes were changed in between."]);

  assert.deepEqual(relatedTo(v2, [v2]), { comparable: [] });
});
