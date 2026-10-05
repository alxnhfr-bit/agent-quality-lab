import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compare,
  type CaseResult,
  type DatasetCase,
  type EvaluationRecord,
  type JsonValue,
  type Manifest,
  type RunData,
  type Verdict,
} from "@agent-quality-lab/core";
import { renderHtmlReport } from "./html.ts";

// Text a candidate, a tool or a dataset could contain. None of it may reach the page as markup.
const HOSTILE = "<script>alert(1)</script>";
const HOSTILE_ID = '"><img src=x onerror=alert(1)>';

function manifest(candidateId: string, config: JsonValue): Manifest {
  return {
    schemaVersion: 1,
    runId: `2026-10-04T09-00-00Z_demo_${candidateId}`,
    scenario: {
      id: "demo",
      version: "1",
      instructions: `Answer the question. ${HOSTILE}`,
      tools: [{ name: "lookup", description: `Looks things up. ${HOSTILE}`, parameters: { type: "object" } }],
    },
    dataset: { name: "dev", sha256: "a".repeat(64), caseCount: 2 },
    candidate: { id: candidateId, version: "1", config, deterministic: true },
    settings: { timeoutMs: 20 },
    startedAt: "2026-10-04T09:00:00.000Z",
    finishedAt: "2026-10-04T09:00:02.000Z",
    environment: { node: "v24.0.0", platform: "test", git: null },
  };
}

const cases: DatasetCase[] = [
  { id: HOSTILE_ID, input: { q: HOSTILE }, expected: HOSTILE, setup: { secret: HOSTILE, stock: 31337 }, tags: [HOSTILE] },
  { id: "plain", input: 1, tags: ["simple"] },
];

function run(candidateId: string, results: [CaseResult, Verdict][]): RunData {
  return {
    manifest: manifest(candidateId, { prompt: HOSTILE }),
    cases,
    results: results.map(([result]) => result),
    evaluations: results.map(
      ([result, verdict]): EvaluationRecord => ({ caseId: result.caseId, evaluator: { id: "correct", version: "1" }, verdict }),
    ),
  };
}

const skipped: Verdict = { outcome: "not_evaluated", detail: "the case did not complete" };

const a = run("first", [
  [
    {
      caseId: HOSTILE_ID,
      status: "completed",
      output: { kind: "answer", value: { note: HOSTILE } },
      durationMs: 1,
      trace: [
        { seq: 0, source: "reported", type: "model_call", model: HOSTILE },
        { seq: 1, source: "observed", type: "tool_call", name: "lookup", args: { q: HOSTILE }, error: HOSTILE },
        { seq: 2, source: "observed", type: "tool_call", name: "lookup", args: null, result: HOSTILE },
        { seq: 3, source: "reported", type: "fallback", from: "lookup", to: "guess", reason: HOSTILE },
      ],
    },
    { outcome: "pass", value: 3, detail: HOSTILE },
  ],
  [{ caseId: "plain", status: "completed", output: { kind: "abstain", reason: HOSTILE }, durationMs: 1, trace: [] }, { outcome: "fail" }],
]);
const b = run("second", [
  [{ caseId: HOSTILE_ID, status: "error", error: { message: HOSTILE, stack: `Error: ${HOSTILE}` }, durationMs: 1, trace: [] }, skipped],
  [{ caseId: "plain", status: "malformed_output", problem: HOSTILE, rawOutput: HOSTILE, durationMs: 1, trace: [] }, skipped],
]);
const comparison = compare(a, b);
const page = renderHtmlReport({ comparison, a, b });

/** The case ids a count in the page would filter the list to. */
function casesBehind(label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`data-cases="([^"]*)" data-label="${escaped}"`).exec(page);
  assert.ok(match, `no count labelled "${label}"`);
  return JSON.parse(match[1]!.replaceAll(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))));
}

test("the report is one page that loads nothing from elsewhere", () => {
  assert.match(page, /^<!doctype html>\n<html lang="en">/);
  assert.doesNotMatch(page, /https?:\/\//);
  assert.doesNotMatch(page, /<(link|img|iframe|object|embed)\b|<script[^>]/);
  assert.equal(page.match(/<script>/g)?.length, 1);
  assert.equal(page.match(/<style>/g)?.length, 1);
});

test("nothing a candidate, a tool or a dataset produced reaches the page as markup", () => {
  assert.equal(page.includes("<script>alert(1)"), false);
  assert.equal(page.includes("<img src=x"), false);
  assert.equal(page.includes('data-case=""'), false);
  // The text is still shown, escaped.
  assert.ok(page.includes("&#60;script&#62;alert(1)&#60;/script&#62;"));
  assert.ok(page.includes("&#34;&#62;&#60;img src=x onerror=alert(1)&#62;"));
});

test("every case is listed, with both sides and its input", () => {
  assert.equal(page.match(/<details class="case"/g)?.length, 2);
  assert.match(page, /<details class="case" data-case="plain">/);
  assert.match(page, /<p class="label">Input<\/p><pre>1<\/pre>/);
  assert.match(page, /differs in status, verdicts, tool calls/);
});

test("the report shows what every candidate was told", () => {
  assert.match(page, /<summary>What every candidate was told<\/summary>/);
  assert.match(page, /<p class="label">Instructions<\/p><pre>Answer the question\. &#60;script&#62;/);
  assert.match(page, /<dt><code>lookup<\/code><\/dt><dd>Looks things up\. &#60;script&#62;/);
});

test("a case's setup is shown, marked as hidden from the candidate", () => {
  assert.equal(page.match(/Setup, hidden from the candidate/g)?.length, 1);
  assert.match(page, /<details class="setup fold"><summary>Setup, hidden from the candidate<\/summary><pre>\{\n  &#34;secret&#34;: &#34;&#60;script&#62;/);
  assert.ok(page.includes("31337"));
});

test("results are broken down by tag, and each tag count filters to its cases", () => {
  assert.match(page, /<h2>By tag<\/h2>/);
  assert.deepEqual(casesBehind("tag simple"), ["plain"]);
  assert.deepEqual(casesBehind("tag simple, A: completed"), ["plain"]);
  // B returned something malformed on that case, so there is nothing to click.
  assert.match(page, /<td><span class="zero">0\/1<\/span><\/td>/);
  assert.match(page, /<span class="tags">simple<\/span>/);
});

test("each count filters the list to exactly the cases behind it", () => {
  assert.deepEqual(casesBehind("correct: passes only in A"), comparison.evaluators[0]?.onlyA);
  assert.deepEqual(casesBehind("correct: passes only in A"), [HOSTILE_ID]);
  assert.deepEqual(casesBehind("B: error"), [HOSTILE_ID]);
  assert.deepEqual(casesBehind("correct, B: not evaluated"), [HOSTILE_ID, "plain"]);
  assert.deepEqual(casesBehind("All"), [HOSTILE_ID, "plain"]);
  assert.deepEqual(casesBehind("Not completed on a side"), [HOSTILE_ID, "plain"]);
  assert.deepEqual(casesBehind("Differ in status or verdicts"), [HOSTILE_ID, "plain"]);
});

test("a count of zero is plain text, not a filter", () => {
  assert.match(page, /<th scope="row">Timeout<\/th><td><span class="zero">0<\/span><\/td><td><span class="zero">0<\/span><\/td>/);
});
