import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { caseResultSchema, manifestSchema } from "./artifact.ts";
import type { Run } from "./runner.ts";
import { loadDataset, parseDataset, readEnvironment, writeRun } from "./store.ts";

const schemas = {
  inputSchema: z.strictObject({ n: z.number() }),
  expectedSchema: z.strictObject({ n: z.number() }),
};

const text = [
  '{"id":"a","input":{"n":1},"expected":{"n":2},"tags":["easy"]}',
  "",
  '{"id":"b","input":{"n":2}}',
  "",
].join("\n");

test("a dataset parses into cases and a hash of the exact text", () => {
  const dataset = parseDataset(schemas, "dev", text);
  assert.deepEqual(dataset.cases, [
    { id: "a", input: { n: 1 }, expected: { n: 2 }, tags: ["easy"] },
    { id: "b", input: { n: 2 } },
  ]);
  assert.match(dataset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(dataset.text, text);
  assert.notEqual(parseDataset(schemas, "dev", `${text}\n`).sha256, dataset.sha256);
});

test("an invalid line fails the whole dataset and names the line", () => {
  const invalid: [string, RegExp][] = [
    ['{"id":"a","input":{"n":1}}\n{oops', /line 2: not valid JSON/],
    ['{"id":"a","input":{"n":1}}\n{"id":"a","input":{"n":2}}', /line 2: duplicate case id "a"/],
    ['{"id":"a","input":{"n":"one"}}', /line 1: input is invalid/],
    ['{"id":"a","input":{"n":1},"expected":{"n":"two"}}', /line 1: expected is invalid/],
    ['{"id":"a","input":{"n":1},"note":"x"}', /line 1/],
  ];
  for (const [bad, message] of invalid) {
    assert.throws(() => parseDataset(schemas, "dev", bad), message);
  }
});

test("asking for a dataset the scenario does not have lists the ones it has", async () => {
  const scenario = { ...schemas, id: "demo", datasets: { dev: new URL("file:///nowhere.jsonl") } };
  await assert.rejects(loadDataset(scenario, "held-out"), /no dataset "held-out" \(available: dev\)/);
});

function runFor(dataset: { sha256: string }): Run {
  return {
    manifest: {
      schemaVersion: 1,
      runId: "2026-10-04T09-00-00Z_demo_echo",
      scenario: { id: "demo", version: "1" },
      dataset: { name: "dev", sha256: dataset.sha256, caseCount: 2 },
      candidate: { id: "echo", version: "1", config: null, deterministic: true },
      settings: { timeoutMs: 20 },
      startedAt: "2026-10-04T09:00:00.000Z",
      finishedAt: "2026-10-04T09:00:02.000Z",
      environment: { node: "v24.0.0", platform: "test", git: null },
    },
    results: [
      { caseId: "a", status: "completed", output: { kind: "answer", value: { n: 2 } }, trace: [], durationMs: 1 },
      { caseId: "b", status: "timeout", timeoutMs: 20, trace: [], durationMs: 20 },
    ],
  };
}

test("a written run reads back as the same manifest, dataset and results", async () => {
  const dataset = parseDataset(schemas, "dev", text);
  const run = runFor(dataset);
  const dir = await writeRun(await mkdtemp(join(tmpdir(), "aql-")), run, dataset);

  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  const results = (await readFile(join(dir, "results.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => caseResultSchema.parse(JSON.parse(line)));

  assert.deepEqual(manifest, run.manifest);
  assert.deepEqual(results, run.results);
  assert.equal(await readFile(join(dir, "dataset.jsonl"), "utf8"), text);
});

test("an existing run is never overwritten", async () => {
  const dataset = parseDataset(schemas, "dev", text);
  const runsDir = await mkdtemp(join(tmpdir(), "aql-"));
  await writeRun(runsDir, runFor(dataset), dataset);
  await assert.rejects(writeRun(runsDir, runFor(dataset), dataset), /already exists/);
});

test("a run that does not match its dataset is refused", async () => {
  const dataset = parseDataset(schemas, "dev", text);
  const runsDir = await mkdtemp(join(tmpdir(), "aql-"));

  await assert.rejects(writeRun(runsDir, runFor(dataset), { text: `${text}edited` }), /does not match the hash/);

  const missingOne = runFor(dataset);
  missingOne.results.pop();
  await assert.rejects(writeRun(runsDir, missingOne, dataset), /expected 2 results, got 1/);
});

test("a result that breaks the format is refused, not written", async () => {
  const dataset = parseDataset(schemas, "dev", text);
  const run = runFor(dataset);
  run.results[0] = { ...run.results[0]!, status: "fallback" } as never;
  await assert.rejects(writeRun(await mkdtemp(join(tmpdir(), "aql-")), run, dataset));
});

test("the environment says so when there is no git checkout", async () => {
  const environment = readEnvironment(await mkdtemp(join(tmpdir(), "aql-")));
  assert.equal(environment.node, process.version);
  assert.equal(environment.git, null);
});
