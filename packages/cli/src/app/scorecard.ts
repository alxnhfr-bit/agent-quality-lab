/**
 * What a finished run says, arranged for a reader who wants to know one thing
 * first: how many answers were good, and which were not and why. Counting only;
 * nothing here judges anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costOf, summarize, type Usage } from "@agent-quality-lab/core";
import { loadRun } from "@agent-quality-lab/core/store";
import { DEMO_MODEL } from "./demo.ts";
import type { Test } from "./workspace.ts";

export interface Scorecard {
  runId: string;
  startedAt: string;
  /** `model` is the model that answered, as the run recorded it. */
  agent: { id: string; name: string; version: string; model: string; instructions: string };
  /**
   * `judgeModel` is the judge the test asked for and `judgedBy` the models that read the answers, as the run
   * recorded them; empty when none was read. `questions` is a fingerprint of the questions and their notes.
   */
  test: { id: string; name: string; judgeModel: string; judgedBy: string[]; questions: string };
  /** What else two results must share to be compared: the time limit per answer and the version of every check. */
  conditions: string;
  /** The run used stand-ins for the models, so its answers and verdicts mean nothing. */
  demo: boolean;
  total: number;
  /** Answers that meet every must-have. */
  good: number;
  /** Answers the judge could not decide a must-have for. They count as neither good nor not good. */
  notJudged: number;
  /** `met` is out of `judged`: the answers the judge gave a verdict on for this criterion. */
  criteria: { id: string; text: string; mustHave: boolean; met: number; judged: number }[];
  /** In US dollars. null when it cannot be worked out. */
  agentCost: number | null;
  judgeCost: number | null;
  medianSeconds: number | null;
  cases: ScoredCase[];
}

export interface ScoredCase {
  id: string;
  question: string;
  note?: string;
  /** Absent when the agent gave no answer; `failure` then says why. */
  answer?: string;
  failure?: string;
  /** No answer is not good. An answer is not judged when no must-have was failed but one went undecided. */
  rating: "good" | "not good" | "not judged";
  verdicts: { text: string; mustHave: boolean; outcome: "met" | "not met" | "not judged"; reason: string }[];
}

interface JudgeLine {
  caseId: string;
  judgement?: { model: string; usage?: Usage };
}

export async function scorecardFor(runsDir: string, runId: string): Promise<Scorecard> {
  const dir = join(runsDir, runId);
  const run = await loadRun(dir);
  const test = JSON.parse(readFileSync(join(dir, "test.json"), "utf8")) as Test;
  const agentFile = join(dir, "agent.json");
  const agentName = existsSync(agentFile) ? (JSON.parse(readFileSync(agentFile, "utf8")) as { name: string }).name : undefined;
  const config = run.manifest.candidate.config as { model: string; instructions: string };
  const { prices } = run.manifest;

  const verdictsByCase = Map.groupBy(run.evaluations ?? [], (record) => record.caseId);
  const cases = run.results.map((result): ScoredCase => {
    const question = run.cases.find((c) => c.id === result.caseId);
    const note = (question?.expected as { note?: string } | undefined)?.note;
    const verdicts = test.criteria.map(({ id, text, mustHave }): ScoredCase["verdicts"][number] => {
      const verdict = verdictsByCase.get(result.caseId)?.find((record) => record.evaluator.id === id)?.verdict;
      const outcome = verdict?.outcome === "pass" ? "met" : verdict?.outcome === "fail" ? "not met" : "not judged";
      const reason =
        verdict?.outcome === "not_evaluated"
          ? "there was no answer to read"
          : (verdict?.detail ?? "").replace(/^the evaluator threw: /, "");
      return { text, mustHave, outcome, reason };
    });
    const answer =
      result.status === "completed" && result.output.kind === "answer" ? String(result.output.value) : undefined;
    return {
      id: result.caseId,
      question: String(question?.input ?? ""),
      ...(note && { note }),
      ...(answer !== undefined
        ? { answer }
        : { failure: result.status === "error" ? result.error.message : result.status.replace("_", " ") }),
      rating: rate(answer !== undefined, verdicts),
      verdicts,
    };
  });

  const summary = summarize(run.results, run.evaluations ?? [], run.cases, prices);
  const judged = existsSync(join(dir, "judge.jsonl"))
    ? readFileSync(join(dir, "judge.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JudgeLine)
    : [];
  const judgeCost = costOf(
    judged.flatMap(({ judgement }, seq) =>
      judgement
        ? [{ seq, source: "reported" as const, type: "model_call" as const, model: judgement.model, ...(judgement.usage && { usage: judgement.usage }) }]
        : [],
    ),
    prices,
  );

  return {
    runId,
    startedAt: run.manifest.startedAt,
    agent: {
      id: run.manifest.candidate.id,
      name: agentName ?? run.manifest.candidate.id,
      version: run.manifest.candidate.version.replace(/^v/, ""),
      model: config.model,
      instructions: config.instructions,
    },
    test: {
      id: run.manifest.scenario.id.replace(/^test-/, ""),
      name: test.name,
      judgeModel: test.judgeModel,
      judgedBy: [...new Set(judged.flatMap(({ judgement }) => (judgement ? [judgement.model] : [])))],
      questions: run.manifest.dataset.sha256,
    },
    conditions: [
      `${run.manifest.settings?.timeoutMs ?? "no"} ms`,
      ...new Set((run.evaluations ?? []).map(({ evaluator }) => `${evaluator.id} ${evaluator.version}`)),
    ].join(", "),
    demo: config.model === DEMO_MODEL,
    total: cases.length,
    good: cases.filter((c) => c.rating === "good").length,
    notJudged: cases.filter((c) => c.rating === "not judged").length,
    criteria: test.criteria.map((criterion, i) => ({
      ...criterion,
      met: cases.filter((c) => c.verdicts[i]?.outcome === "met").length,
      judged: cases.filter((c) => c.verdicts[i]?.outcome !== "not judged").length,
    })),
    agentCost: summary.cost && summary.cost.unpricedModelCalls === 0 ? summary.cost.total : null,
    judgeCost: prices && judgeCost.unpriced === 0 ? Math.round(judgeCost.total * 1e6) / 1e6 : null,
    medianSeconds: summary.durationMs ? Math.round(summary.durationMs.median / 100) / 10 : null,
    cases,
  };
}

function rate(answered: boolean, verdicts: ScoredCase["verdicts"]): ScoredCase["rating"] {
  const mustHaves = verdicts.filter((v) => v.mustHave);
  if (!answered || mustHaves.some((v) => v.outcome === "not met")) return "not good";
  return mustHaves.every((v) => v.outcome === "met") ? "good" : "not judged";
}
