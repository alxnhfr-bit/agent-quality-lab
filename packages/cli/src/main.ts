#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
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

  aql ui [--port <n>] [--demo] [--no-open] [--workspace <folder>]
      Open the interface in your browser: describe an agent, describe a test, read the scorecard.
      --demo tries it out without calling any model.
      --workspace is where your agents, tests and results are kept (default: workspace).

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
        port: { type: "string" },
        demo: { type: "boolean" },
        "no-open": { type: "boolean" },
        workspace: { type: "string" },
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

  if (command === "ui" && target === undefined) {
    return startUi(root, {
      port: number(values.port, "--port", (n) => Number.isInteger(n) && n > 0 && n < 65536) ?? 4310,
      demo: values.demo ?? false,
      open: !values["no-open"],
      workspace: values.workspace ?? "workspace",
    });
  }
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

/** Starts the interface and keeps running until it is stopped with Ctrl-C. */
async function startUi(
  root: string,
  options: { port: number; demo: boolean; open: boolean; workspace: string },
): Promise<string> {
  const { createApp } = await import("./app/server.ts");
  const { demoModels } = await import("./app/demo.ts");
  const { ANTHROPIC_PRICES, claude } = await import("@agent-quality-lab/models/anthropic");

  const server = createApp({
    root,
    workspaceDir: resolve(root, options.workspace),
    models: options.demo ? demoModels() : { client: claude, prices: ANTHROPIC_PRICES },
    demo: options.demo,
    keyFound: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new UsageError(`port ${options.port} is in use; try --port with another number`) : error),
    );
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = `http://localhost:${options.port}`;
  if (options.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [address], { stdio: "ignore", detached: true }).on("error", () => {});
  }
  return `Agent Quality Lab is running at ${address}${options.demo ? " in demo mode" : ""}. Press Ctrl-C to stop it.`;
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
