#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { projectRoot } from "@agent-quality-lab/core/store";
import { UsageError, compareCommand, evalCommand, runCommand } from "./commands.ts";

const USAGE = `Usage:
  aql run <scenario> --candidate <name> [--dataset <name>]
      Execute a candidate on a scenario's dataset, score it, and write the run to runs/.

  aql eval <run>
      Score an existing run again with the scenario's current evaluators.

  aql compare <run-a> <run-b>
      Show where two runs of the same scenario and dataset differ, case by case.

A run is named by its id (its directory name under runs/) or by a path.
Scenarios live in scenarios/<scenario>/scenario.ts, candidates next to them in candidates/<name>.ts.`;

async function main(argv: string[]): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        candidate: { type: "string" },
        dataset: { type: "string" },
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
    return compareCommand(project, { a: target, b: second });
  }
  if (second !== undefined) throw new UsageError(USAGE);
  if (command === "run" && target && values.candidate && extra.length === 0) {
    return runCommand(
      project,
      { scenario: target, candidate: values.candidate, dataset: values.dataset },
      (line) => console.error(line),
    );
  }
  if (command === "eval" && target && extra.length === 0) {
    return evalCommand(project, { run: target });
  }
  throw new UsageError(USAGE);
}

main(process.argv.slice(2)).then(
  (output) => console.log(output),
  (error) => {
    console.error(error instanceof UsageError ? `aql: ${error.message}` : error);
    process.exitCode = 1;
  },
);
