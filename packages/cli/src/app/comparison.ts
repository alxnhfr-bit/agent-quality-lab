/**
 * Two results of the same test, question by question: which answers got
 * better, which got worse, and whether that is more than chance. Counting
 * only; it reads two scorecards and judges nothing itself.
 */
import type { Scorecard, ScoredCase } from "./scorecard.ts";

/** How a question's answer moved from the first result to the second. */
export type Change = "worse" | "better" | "not compared" | "not good in both" | "good in both";

/** Listed in this order: what got worse is what a reader has to see first. */
export const CHANGES: readonly Change[] = ["worse", "better", "not compared", "not good in both", "good in both"];

export interface Comparison {
  a: Scorecard;
  b: Scorecard;
  counts: Record<Change, number>;
  /**
   * Whether the answers that changed are split too one-sidedly for chance. With
   * one run per side, anything short of that could be the same agent on another day.
   */
  certainty: "no change" | "could be chance" | "more than chance";
  /** `met` is out of `judged`, as on a scorecard. */
  criteria: { text: string; mustHave: boolean; a: { met: number; judged: number }; b: { met: number; judged: number } }[];
  /** In the order of the test. */
  questions: { id: string; question: string; note?: string; change: Change; a: ScoredCase; b: ScoredCase }[];
}

/**
 * Why two results cannot be put side by side, in words for the person who
 * wrote the test; empty when they can. They have to be answers to the same
 * questions, judged the same way.
 */
export function differences(a: Scorecard, b: Scorecard): string[] {
  if (a.demo !== b.demo) return ["One of them is a demo run, in which no model was called."];
  if (a.test.id !== b.test.id) return [`They are results of two different tests, "${a.test.name}" and "${b.test.name}".`];

  const reasons: string[] = [];
  if (a.test.questions !== b.test.questions) reasons.push("The test's questions or their notes were changed in between.");
  const criteria = (card: Scorecard) => JSON.stringify(card.criteria.map(({ text, mustHave }) => [text, mustHave]));
  if (criteria(a) !== criteria(b)) reasons.push("The test's description of a good answer was changed in between.");
  // A result in which the judge read nothing names no model that did.
  const judgedBy = (card: Scorecard) => card.test.judgedBy.join();
  if (a.test.judgeModel !== b.test.judgeModel || (judgedBy(a) && judgedBy(b) && judgedBy(a) !== judgedBy(b))) {
    reasons.push("They were judged by different models.");
  }
  if (reasons.length === 0 && a.conditions !== b.conditions) {
    reasons.push("The lab itself changed in between, so they were not run and judged in the same way.");
  }
  return reasons;
}

/**
 * The order two results are shown in when nobody chose one: an agent's lower
 * version first, otherwise the earlier run first.
 */
export function inOrder(x: Scorecard, y: Scorecard): [Scorecard, Scorecard] {
  const byVersion = x.agent.id === y.agent.id ? Number(x.agent.version) - Number(y.agent.version) : 0;
  return (byVersion || x.startedAt.localeCompare(y.startedAt)) <= 0 ? [x, y] : [y, x];
}

export function compareResults(a: Scorecard, b: Scorecard): Comparison {
  const reasons = differences(a, b);
  if (reasons.length > 0) throw new Error(`the two results cannot be compared: ${reasons.join(" ")}`);

  const questions = a.cases.map((first): Comparison["questions"][number] => {
    const second = b.cases.find((c) => c.id === first.id);
    if (!second) throw new Error(`question "${first.id}" has an answer in one result only`);
    return {
      id: first.id,
      question: first.question,
      ...(first.note && { note: first.note }),
      change: changeOf(first.rating, second.rating),
      a: first,
      b: second,
    };
  });
  const counts = Object.fromEntries(
    CHANGES.map((change) => [change, questions.filter((q) => q.change === change).length]),
  ) as Record<Change, number>;

  return {
    a,
    b,
    counts,
    certainty:
      counts.better + counts.worse === 0
        ? "no change"
        : chance(counts.better, counts.worse) < 0.05
          ? "more than chance"
          : "could be chance",
    criteria: a.criteria.map(({ text, mustHave, met, judged }, i) => ({
      text,
      mustHave,
      a: { met, judged },
      b: { met: b.criteria[i]!.met, judged: b.criteria[i]!.judged },
    })),
    questions,
  };
}

function changeOf(first: ScoredCase["rating"], second: ScoredCase["rating"]): Change {
  if (first === "not judged" || second === "not judged") return "not compared";
  if (first === second) return first === "good" ? "good in both" : "not good in both";
  return second === "good" ? "better" : "worse";
}

/**
 * How often a split at least this one-sided turns up when the two results are
 * in truth equally good, so that each answer that changed was as likely to get
 * better as worse. This is the sign test, counted exactly.
 */
export function chance(better: number, worse: number): number {
  const changed = better + worse;
  let ways = 0;
  for (let k = 0, choose = 1; k <= Math.min(better, worse); k++) {
    ways += choose;
    choose = (choose * (changed - k)) / (k + 1);
  }
  return Math.min(1, (2 * ways) / 2 ** changed);
}

export interface Related {
  /** Every other result that can be put next to this one, newest first. */
  comparable: Scorecard[];
  /** The latest result of the agent's version before this one, when the two can be compared. */
  previous?: Scorecard;
  /** Without a `previous`: an earlier version's latest result on this test that cannot be compared, and why. */
  outdated?: { card: Scorecard; reasons: string[] };
}

/** What a result can be compared with, out of every other result there is. */
export function relatedTo(card: Scorecard, others: readonly Scorecard[]): Related {
  const newestFirst = others
    .filter((other) => other.runId !== card.runId)
    .toSorted((x, y) => y.startedAt.localeCompare(x.startedAt));
  const comparable = newestFirst.filter((other) => differences(card, other).length === 0);

  const earlier = (candidates: Scorecard[]) =>
    candidates
      .filter((other) => other.agent.id === card.agent.id && Number(other.agent.version) < Number(card.agent.version))
      // The sort keeps the newest run first within one version.
      .toSorted((x, y) => Number(y.agent.version) - Number(x.agent.version))[0];
  const previous = earlier(comparable);
  if (previous) return { comparable, previous };

  const outdated = earlier(newestFirst.filter((other) => other.test.id === card.test.id && other.demo === card.demo));
  return { comparable, ...(outdated && { outdated: { card: outdated, reasons: differences(card, outdated) } }) };
}
