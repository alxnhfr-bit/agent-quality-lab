import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadRun } from "@agent-quality-lab/core/store";
import { RunStopped, UsageError, compareCommand, evalCommand, importCommand, runCommand, type Project } from "./commands.ts";

const root = resolve(import.meta.dirname, "../../..");

async function project(): Promise<Project> {
  return { root, runsDir: await mkdtemp(join(tmpdir(), "aql-")) };
}

async function onlyRun(runsDir: string): Promise<string> {
  const [runId, ...others] = await readdir(runsDir);
  assert.ok(runId && others.length === 0);
  return runId;
}

test("run executes a candidate, writes the run and scores it", async () => {
  const p = await project();
  const progress: string[] = [];
  const output = await runCommand(p, { scenario: "stock-check", candidate: "baseline" }, (line) => progress.push(line));

  const runId = await onlyRun(p.runsDir);
  const run = await loadRun(join(p.runsDir, runId));
  assert.equal(run.manifest.candidate.id, "baseline");
  assert.equal(run.results.length, 12);
  assert.equal(run.evaluations?.length, 24);
  assert.ok(run.evaluations.every((record) => record.verdict.outcome === "pass"));

  assert.equal(progress.length, 12);
  assert.equal(progress[0], "[1/12] in-stock: completed");
  assert.match(output, new RegExp(`^stock-check v1 · baseline v1 · dataset dev · 12 cases\nrun ${runId}\n`));
  assert.match(output, /correctness  1        12\/12  0     0    0                0/);
  assert.match(output, /\ntag +cases +completed +correctness pass +tool-use pass\nboundary +5 +5\/5 +5\/5 +5\/5\n/);
});

test("eval scores a stored run again and arrives at the same report", async () => {
  const p = await project();
  const output = await runCommand(p, { scenario: "stock-check", candidate: "mock-agent" }, () => {});
  const runId = await onlyRun(p.runsDir);
  const before = (await loadRun(join(p.runsDir, runId))).evaluations;

  assert.equal(await evalCommand(p, { run: runId }), output);
  assert.equal(await evalCommand(p, { run: join(p.runsDir, runId) }), output);
  assert.deepEqual((await loadRun(join(p.runsDir, runId))).evaluations, before);
});

test("a crash is recorded with paths relative to the project", async () => {
  const p = await project();
  await runCommand(p, { scenario: "stock-check", candidate: "mock-agent" }, () => {});
  const results = await readFile(join(p.runsDir, await onlyRun(p.runsDir), "results.jsonl"), "utf8");

  assert.match(results, /at Object\.run \(scenarios\/stock-check\/candidates\/mock-agent\.ts:\d+:\d+\)/);
  assert.equal(results.includes(root), false);
});

test("compare shows where two stored runs differ, and refuses a run that is not scored", async () => {
  const p = await project();
  await runCommand(p, { scenario: "stock-check", candidate: "baseline" }, () => {});
  await runCommand(p, { scenario: "stock-check", candidate: "mock-agent" }, () => {});
  const runIds = await readdir(p.runsDir);
  const a = runIds.find((id) => id.endsWith("_baseline"))!;
  const b = runIds.find((id) => id.endsWith("_mock-agent"))!;

  const output = await compareCommand(p, { a, b });
  assert.match(output, /\nA  baseline v1    run .*_baseline\nB  mock-agent v1  run .*_mock-agent\n/);
  assert.match(output, /\ncorrectness pass +12\/12 +6\/12\n/);
  assert.match(output, /\n  correctness  passes only in A \(6\)  in-stock, small-exact, small-one-over, unknown-item, flaky-lookup-over, service-down\n/);
  assert.match(output, /\ncases that differ in status or verdicts \(8 of 12\)\n/);
  assert.match(output, /\ntool-failure +3 +3\/3 · 3\/3 +3\/3 · 1\/3 +3\/3 · 0\/3\n/);

  await rm(join(p.runsDir, b, "evaluations.jsonl"));
  await assert.rejects(
    compareCommand(p, { a, b }),
    (error: unknown) => error instanceof UsageError && error.message.includes(`has not been scored: run "aql eval ${b}"`),
  );
});

test("compare writes the comparison as an HTML page when asked", async () => {
  const p = await project();
  await runCommand(p, { scenario: "stock-check", candidate: "baseline" }, () => {});
  await runCommand(p, { scenario: "stock-check", candidate: "mock-agent" }, () => {});
  const runIds = await readdir(p.runsDir);
  const a = runIds.find((id) => id.endsWith("_baseline"))!;
  const b = runIds.find((id) => id.endsWith("_mock-agent"))!;
  const file = join(p.runsDir, "report.html");

  const output = await compareCommand(p, { a, b, html: file });
  assert.ok(output.endsWith(`HTML report written to ${file}`));
  assert.equal(output.split("\n\nHTML report written to")[0], await compareCommand(p, { a, b }));

  const page = await readFile(file, "utf8");
  assert.ok(page.includes(a) && page.includes(b));
  assert.equal(page.match(/<details class="case"/g)?.length, 12);
  assert.equal(page.includes(root), false);
});

test("a run that passes its spending limit stops, keeps what it has, and is not scored", async () => {
  const p = await project();
  // A limit below zero is passed by the first case, whatever that case cost.
  await assert.rejects(
    runCommand(p, { scenario: "stock-check", candidate: "baseline", maxCost: -1 }, () => {}),
    (error: unknown) =>
      error instanceof RunStopped &&
      /was stopped: the spending limit of -1\.00 USD was passed after 1 of 12 cases/.test(error.message) &&
      /1 of 12 cases are saved/.test(error.message),
  );

  const runId = await onlyRun(p.runsDir);
  const run = await loadRun(join(p.runsDir, runId));
  assert.equal(run.complete, false);
  assert.equal(run.results.length, 1);
  assert.equal(run.evaluations, null);
  await assert.rejects(
    evalCommand(p, { run: runId }),
    (error: unknown) => error instanceof UsageError && /is incomplete, with 1 of 12 cases: the spending limit/.test(error.message),
  );
});

test("running several cases at once gives the same report as running them one by one", async () => {
  const [one, many] = [await project(), await project()];
  const report = async (p: Project, concurrency: number) =>
    (await runCommand(p, { scenario: "travel-cancellation", candidate: "rules", concurrency }, () => {}))
      .split("\n")
      // The run id carries the time, and durations vary.
      .filter((line) => !line.startsWith("run ") && !line.startsWith("duration"));
  assert.deepEqual(await report(many, 6), await report(one, 1));
  assert.equal((await loadRun(join(many.runsDir, await onlyRun(many.runsDir)))).manifest.settings?.concurrency, 6);
});

/** Answers to every stock-check case, as another system might have recorded them, in a file outside the project. */
async function answersFile(startedAt: string, keep = (_i: number) => true): Promise<string> {
  const cases = (await readFile(join(root, "scenarios", "stock-check", "datasets", "dev.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; expected: { behaviour: string; canFulfil?: boolean } });
  const answers = cases
    .filter((_c, i) => keep(i))
    .map((c) => (c.expected.behaviour === "abstain" ? { caseId: c.id, abstain: "cannot tell" } : { caseId: c.id, answer: { canFulfil: c.expected.canFulfil } }));
  const file = join(await mkdtemp(join(tmpdir(), "aql-answers-")), "answers.json");
  await writeFile(file, JSON.stringify({ candidate: { id: "elsewhere", version: "run-7", config: { system: "a spreadsheet" } }, startedAt, answers }));
  return file;
}

test("import loads answers made elsewhere as a scored run, and says what the lab did not see", async () => {
  const p = await project();
  const file = await answersFile("2026-08-01T09:00:00.000Z");
  const output = await importCommand(p, { scenario: "stock-check", answers: file });

  assert.match(output, /^stock-check v1 · elsewhere run-7 · dataset dev · 12 cases\nrun 2026-08-01T09-00-00Z_stock-check_elsewhere\n/);
  assert.match(output, /\nnote: these answers were imported from answers\.json, not run by the lab: it measured no durations/);
  assert.match(output, /\ntool calls +not imported\n/);
  assert.equal(output.includes("duration "), false);
  assert.match(output, /\ncorrectness +1 +12\/12 /);

  const run = await loadRun(join(p.runsDir, await onlyRun(p.runsDir)));
  assert.deepEqual(run.manifest.origin, {
    kind: "imported",
    source: "answers.json",
    sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  });
  assert.equal(run.manifest.settings, undefined);
  assert.ok(run.results.every((result) => result.durationMs === undefined));

  // Two imports compare like two runs, without claiming tool calls nobody recorded.
  await importCommand(p, { scenario: "stock-check", answers: await answersFile("2026-08-02T09:00:00.000Z") });
  const [a, b] = (await readdir(p.runsDir)).sort();
  const comparison = await compareCommand(p, { a: a!, b: b! });
  assert.match(comparison, /\nnote: A: these answers were imported from answers\.json/);
  assert.match(comparison, /\ntool calls +not imported +not imported\n/);
});

test("import refuses answers that cannot be read or do not cover every case, and saves nothing", async () => {
  const p = await project();
  const refused = (file: string, message: RegExp) =>
    assert.rejects(importCommand(p, { scenario: "stock-check", answers: file }), (error: unknown) => error instanceof UsageError && message.test(error.message));

  await refused(join(p.runsDir, "nowhere.json"), /no answers file at/);
  const broken = join(await mkdtemp(join(tmpdir(), "aql-answers-")), "broken.json");
  await writeFile(broken, "{ not json");
  await refused(broken, /broken\.json cannot be imported: /);
  await refused(await answersFile("2026-08-01T09:00:00.000Z", (i) => i < 2), /cannot be imported: the answers cover 2 of the 12 cases; missing: /);
  assert.deepEqual(await readdir(p.runsDir), []);
});

test("mistakes in usage name what is available", async () => {
  const p = await project();
  const run = (args: Parameters<typeof runCommand>[1]) => runCommand(p, args, () => {});
  const usage = (message: RegExp) => (error: unknown) => error instanceof UsageError && message.test(error.message);

  await assert.rejects(run({ scenario: "nope", candidate: "baseline" }), usage(/no scenario "nope" \(available: .*stock-check.*\)/));
  await assert.rejects(
    run({ scenario: "stock-check", candidate: "nope" }),
    // The scenario's own candidates come first, then the ones that work for any scenario.
    usage(/no candidate "nope" \(available: baseline, mock-agent, haiku, opus, sonnet\)/),
  );
  await assert.rejects(
    run({ scenario: "stock-check", candidate: "baseline", dataset: "held-out" }),
    usage(/no dataset "held-out" \(available: dev\)/),
  );
  await assert.rejects(evalCommand(p, { run: "missing" }), usage(/no run found/));
  assert.deepEqual(await readdir(p.runsDir), []);
});

test("the aql command exits with 1 and a message on a usage mistake", async () => {
  const main = join(root, "packages/cli/src/main.ts");
  const failure = await promisify(execFile)(process.execPath, [main, "run", "nope", "--candidate", "x"], { cwd: root }).then(
    () => null,
    (error: { code: number; stderr: string }) => error,
  );
  assert.equal(failure?.code, 1);
  assert.match(failure?.stderr ?? "", /^aql: no scenario "nope"/);
});
