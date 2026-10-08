#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { projectRoot } from "@agent-quality-lab/core/store";
import { DEFAULT_MAX_COST, RunStopped, UsageError, compareCommand, evalCommand, runCommand } from "./commands.ts";

const USAGE = `Usage:
  aql run <scenario> --candidate <name> [--dataset <name>] [--concurrency <n>] [--max-cost <usd>]
      Execute a candidate on a scenario's dataset, score it, and write the run to runs/.
      --concurrency runs several cases at once (default 1).
      --max-cost stops the run once its model calls have cost more than this (default ${DEFAULT_MAX_COST}).

  aql eval <run>
      Score an existing run again with the scenario's current evaluators.

  aql compare <run-a> <run-b> [--html <file>]
      Show where two runs of the same scenario and dataset differ, case by case.
      With --html, also write the comparison as one self-contained page.

A run is named by its id (its directory name under runs/) or by a path.
Scenarios live in scenarios/<scenario>/scenario.ts and their candidates next to them in candidates/<name>.ts.
Candidates that work for any scenario live in candidates/<name>.ts at the project root.`;

async function main(argv: string[]): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        candidate: { type: "string" },
        dataset: { type: "string" },
        concurrency: { type: "string" },
        "max-cost": { type: "string" },
        html: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, target, second, ...extra] = positionals;
  if (values.help || command === undefined) return USAGE;

  const root = projectRoot();
  const project = { root, runsDir: join(root, "runs") };

  if (command === "compare" && target && second && extra.length === 0) {
    return compareCommand(project, { a: target, b: second, html: values.html });
  }
  if (second !== undefined) throw new UsageError(USAGE);
  if (command === "run" && target && values.candidate && extra.length === 0) {
    return runCommand(
      project,
      {
        scenario: target,
        candidate: values.candidate,
        dataset: values.dataset,
        concurrency: number(values.concurrency, "--concurrency", (n) => Number.isInteger(n) && n >= 1),
        maxCost: number(values["max-cost"], "--max-cost", (n) => n >= 0),
      },
      (line) => console.error(line),
    );
  }
  if (command === "eval" && target && extra.length === 0) {
    return evalCommand(project, { run: target });
  }
  throw new UsageError(USAGE);
}

function number(value: string | undefined, flag: string, valid: (n: number) => boolean): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || !valid(parsed)) throw new UsageError(`${flag} does not accept "${value}"`);
  return parsed;
}

main(process.argv.slice(2)).then(
  (output) => console.log(output),
  (error) => {
    console.error(error instanceof UsageError || error instanceof RunStopped ? `aql: ${error.message}` : error);
    process.exitCode = 1;
  },
);
