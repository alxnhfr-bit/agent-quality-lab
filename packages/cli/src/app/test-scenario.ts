/**
 * Turns a test a person described, example questions plus criteria in plain
 * words, into a scenario the lab can run. Each criterion becomes one check,
 * and a judge model decides all of an answer's checks in one go.
 */
import { createHash } from "node:crypto";
import type { Case, CaseResult, Evaluator, Scenario } from "@agent-quality-lab/core";
import { JUDGE_VERSION, type Judge, type Judgement } from "@agent-quality-lab/models";
import { z } from "zod";
import type { Test } from "./workspace.ts";

type Expected = { note?: string | undefined };

export interface TestScenario {
  scenario: Scenario<string, string, Expected>;
  /** The questions as the lab stores a dataset: one case per line. */
  datasetText: string;
  /** Has the judge read every completed answer, a few at a time. Evaluating afterwards reuses what it said. */
  judgeAll(
    cases: readonly Case<string, Expected>[],
    results: readonly CaseResult[],
    concurrency: number,
    onProgress?: (done: number) => void,
  ): Promise<void>;
  /** What the judge said about each case it has read so far, or why it could not. */
  judgements(): Promise<{ caseId: string; judgement?: Judgement; error?: string }[]>;
}

export function scenarioFor(testId: string, test: Test, judge: Judge): TestScenario {
  const asked = new Map<string, Promise<Judgement>>();
  const ask = (c: Case<string, Expected>, answer: string): Promise<Judgement> => {
    if (!asked.has(c.id)) {
      asked.set(c.id, judge({ question: c.input, note: c.expected?.note, answer, criteria: test.criteria }));
    }
    return asked.get(c.id)!;
  };

  const evaluators = test.criteria.map(
    (criterion): Evaluator<string, string, Expected> => ({
      id: criterion.id,
      // A different judge, or a reworded criterion, gives verdicts that must not be mixed with the old ones.
      version: createHash("sha256")
        .update(`${JUDGE_VERSION}\n${test.judgeModel}\n${criterion.text}`)
        .digest("hex")
        .slice(0, 8),
      async evaluate(c, { output }) {
        const judgement = await ask(c, output.kind === "answer" ? output.value : output.reason);
        const verdict = judgement.verdicts[criterion.id];
        if (!verdict) throw new Error("the judge gave no verdict on this criterion");
        return { outcome: verdict.met ? "pass" : "fail", detail: verdict.reason };
      },
    }),
  );

  return {
    scenario: {
      id: `test-${testId}`,
      version: "1",
      inputSchema: z.string(),
      outputSchema: z.string(),
      answerFormat: { type: "string" },
      expectedSchema: z.strictObject({ note: z.string().optional() }),
      // The agent brings its own instructions; the test adds none.
      instructions: "",
      datasets: {},
      evaluators,
      timeoutMs: 120_000,
    },
    datasetText: test.questions
      .map((q) => `${JSON.stringify({ id: q.id, input: q.text, ...(q.note && { expected: { note: q.note } }) })}\n`)
      .join(""),

    async judgeAll(cases, results, concurrency, onProgress) {
      const byId = new Map(cases.map((c) => [c.id, c]));
      const waiting = results.filter((result) => result.status === "completed");
      let done = 0;
      const work = async () => {
        for (let result = waiting.shift(); result; result = waiting.shift()) {
          if (result.status !== "completed") continue;
          const { output } = result;
          const answer = output.kind === "answer" ? String(output.value) : output.reason;
          // A judge that fails here fails again, visibly, when the answer is evaluated.
          await ask(byId.get(result.caseId)!, answer).catch(() => {});
          onProgress?.(++done);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
    },

    async judgements() {
      return Promise.all(
        [...asked].map(async ([caseId, pending]) =>
          pending.then(
            (judgement) => ({ caseId, judgement }),
            (error: unknown) => ({ caseId, error: error instanceof Error ? error.message : String(error) }),
          ),
        ),
      );
    },
  };
}
