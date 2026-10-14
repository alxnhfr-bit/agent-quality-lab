/**
 * Runs a test against one version of an agent, in the background, and says how
 * far it has got. A run is two passes: the agent answers every question, then
 * the judge reads every answer.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateRun, executeRun, type Prices } from "@agent-quality-lab/core";
import {
  loadRun,
  openRun,
  parseDataset,
  readEnvironment,
  writeEvaluations,
  type RunWriter,
} from "@agent-quality-lab/core/store";
import { createJudge, promptAgent, type ModelClient } from "@agent-quality-lab/models";
import { scenarioFor } from "./test-scenario.ts";
import type { AgentVersion, Test } from "./workspace.ts";

/** Where models come from. Swapped for stand-ins in demo mode and in tests. */
export interface Models {
  client(model: string): ModelClient;
  prices?: Prices;
}

export type RunState =
  | { phase: "answering" | "judging"; done: number; total: number }
  | { phase: "done" }
  | { phase: "stopped" | "failed"; reason: string };

const CONCURRENCY = 4;
/** In US dollars, for the agent's answers. */
export const MAX_COST = 5;

export class Runs {
  readonly #runsDir: string;
  readonly #root: string;
  readonly #models: Models;
  readonly #now: (() => Date) | undefined;
  readonly #states = new Map<string, RunState>();

  /** `now` is for tests: a run is named after the second it started in. */
  constructor(options: { root: string; runsDir: string; models: Models; now?: (() => Date) | undefined }) {
    this.#root = options.root;
    this.#runsDir = options.runsDir;
    this.#models = options.models;
    this.#now = options.now;
  }

  /** Starts a run and returns its id as soon as it exists on disk. The run carries on in the background. */
  start(agent: { id: string; name: string; version: AgentVersion }, testId: string, test: Test): Promise<string> {
    const { version } = agent;
    const candidate = promptAgent({
      id: agent.id,
      version: `v${version.version}`,
      instructions: version.instructions,
      client: this.#models.client(version.model),
      ...(this.#models.prices && { prices: this.#models.prices }),
    });
    const { scenario, datasetText, judgeAll, judgements } = scenarioFor(
      testId,
      test,
      createJudge(this.#models.client(test.judgeModel)),
    );
    const dataset = parseDataset(scenario, "questions", datasetText);
    const total = dataset.cases.length;

    return new Promise<string>((resolve, reject) => {
      let writer: RunWriter | undefined;
      let runId: string | undefined;
      const set = (state: RunState) => this.#states.set(runId!, state);

      executeRun(scenario, candidate, dataset, {
        environment: readEnvironment(this.#root),
        ...(this.#now && { now: this.#now }),
        concurrency: CONCURRENCY,
        maxCost: MAX_COST,
        onStart: async (manifest) => {
          writer = await openRun(this.#runsDir, manifest, dataset);
          // The test and the agent's name as they were when it ran, so the scorecard does not change if they are edited later.
          writeFileSync(join(writer.dir, "test.json"), `${JSON.stringify(test, null, 2)}\n`);
          writeFileSync(join(writer.dir, "agent.json"), `${JSON.stringify({ name: agent.name }, null, 2)}\n`);
          runId = manifest.runId;
          set({ phase: "answering", done: 0, total });
          resolve(runId);
        },
        onCaseDone: async (result, done) => {
          await writer!.append(result);
          set({ phase: "answering", done, total });
        },
      })
        .then(async (run) => {
          await writer!.finish(run.manifest);
          if (run.manifest.stopped) return set({ phase: "stopped", reason: run.manifest.stopped.reason });

          set({ phase: "judging", done: 0, total });
          await judgeAll(dataset.cases, run.results, CONCURRENCY, (done) => set({ phase: "judging", done, total }));
          await writeEvaluations(writer!.dir, await evaluateRun(scenario, dataset.cases, run.results));
          const lines = (await judgements()).map((line) => `${JSON.stringify(line)}\n`).join("");
          writeFileSync(join(writer!.dir, "judge.jsonl"), lines);
          set({ phase: "done" });
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          if (runId === undefined) reject(error);
          else set({ phase: "failed", reason });
        });
    });
  }

  /** How far a run has got. A run from an earlier session is read from what it left on disk. */
  async state(runId: string): Promise<RunState | undefined> {
    const live = this.#states.get(runId);
    if (live) return live;
    const dir = join(this.#runsDir, runId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || !existsSync(join(dir, "manifest.json"))) return undefined;
    const run = await loadRun(dir);
    if (run.complete && run.evaluations) return { phase: "done" };
    return {
      phase: "stopped",
      reason: run.manifest.stopped?.reason ?? "the run was interrupted before it finished",
    };
  }
}
