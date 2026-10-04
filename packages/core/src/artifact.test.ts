import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  caseResultSchema,
  evaluationRecordSchema,
  judgmentSchema,
  manifestSchema,
  traceEventSchema,
  verdictSchema,
  type CaseResult,
  type JsonValue,
} from "./artifact.ts";
import type { CandidateOutput, Schema } from "./types.ts";

const base = { caseId: "c1", trace: [], durationMs: 12 };

const manifest = {
  schemaVersion: 1,
  runId: "2026-10-04T09-00-00Z_demo_baseline",
  scenario: { id: "demo", version: "1" },
  dataset: { name: "dev", sha256: "a".repeat(64), caseCount: 12 },
  candidate: { id: "baseline", version: "1", config: { seed: 7 }, deterministic: true },
  settings: { timeoutMs: 1000 },
  startedAt: "2026-10-04T09:00:00Z",
  finishedAt: "2026-10-04T09:00:02Z",
  environment: { node: "v24.16.0", platform: "darwin", git: null },
};

test("each execution status accepts its own shape", () => {
  const results = [
    { ...base, status: "completed", output: { kind: "answer", value: { price: 4 } } },
    { ...base, status: "completed", output: { kind: "abstain", reason: "unknown sku" } },
    { ...base, status: "malformed_output", problem: "missing kind", rawOutput: "4" },
    { ...base, status: "malformed_output", problem: "returned undefined" },
    { ...base, status: "error", error: { message: "boom" } },
    { ...base, status: "timeout", timeoutMs: 1000 },
  ];
  for (const result of results) assert.deepEqual(caseResultSchema.parse(result), result);
});

test("a completed result must carry an output", () => {
  assert.equal(caseResultSchema.safeParse({ ...base, status: "completed" }).success, false);
});

test("a failed result cannot carry a valid-looking output", () => {
  const disguised = {
    ...base,
    status: "error",
    error: { message: "boom" },
    output: { kind: "answer", value: 4 },
  };
  assert.equal(caseResultSchema.safeParse(disguised).success, false);
});

test("an unknown status is rejected", () => {
  assert.equal(caseResultSchema.safeParse({ ...base, status: "fallback" }).success, false);
});

test("a tool call may fail, but not fail and succeed at once", () => {
  const call = { seq: 0, source: "observed", type: "tool_call", name: "lookup", args: { sku: "a" } };
  assert.equal(traceEventSchema.safeParse({ ...call, result: null }).success, true);
  assert.equal(traceEventSchema.safeParse({ ...call, error: "unavailable" }).success, true);
  assert.equal(traceEventSchema.safeParse({ ...call, result: 4, error: "unavailable" }).success, false);
});

test("a trace event must say whether it was observed or reported", () => {
  const event = { seq: 0, type: "fallback", from: "model", to: "rules", reason: "rate limited" };
  assert.equal(traceEventSchema.safeParse(event).success, false);
  assert.equal(traceEventSchema.safeParse({ ...event, source: "reported" }).success, true);
});

test("a verdict that is not pass or fail must explain itself", () => {
  const record = (verdict: unknown) => ({
    caseId: "c1",
    evaluator: { id: "correctness", version: "1" },
    verdict,
  });
  assert.equal(evaluationRecordSchema.safeParse(record({ outcome: "pass" })).success, true);
  assert.equal(evaluationRecordSchema.safeParse(record({ outcome: "fail", value: 2 })).success, true);
  assert.equal(evaluationRecordSchema.safeParse(record({ outcome: "error" })).success, false);
  assert.equal(evaluationRecordSchema.safeParse(record({ outcome: "not_applicable" })).success, false);
  assert.equal(
    evaluationRecordSchema.safeParse(record({ outcome: "error", detail: "threw" })).success,
    true,
  );
});

test("a case that never reached an evaluator is recorded as such, and an evaluator cannot claim it", () => {
  const skipped = { outcome: "not_evaluated", detail: "the case did not complete (timeout)" };
  assert.equal(verdictSchema.safeParse(skipped).success, true);
  assert.equal(verdictSchema.safeParse({ outcome: "not_evaluated" }).success, false);
  assert.equal(judgmentSchema.safeParse(skipped).success, false);
});

test("a manifest parses, and one from another schema version does not", () => {
  assert.deepEqual(manifestSchema.parse(manifest), manifest);
  assert.equal(manifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success, false);
});

test("unknown fields are rejected rather than dropped", () => {
  assert.equal(manifestSchema.safeParse({ ...manifest, model: "x" }).success, false);
});

test("a zod schema can be used wherever a Schema is expected", () => {
  const schema: Schema<{ sku: string }> = z.object({ sku: z.string() });
  assert.equal(schema.safeParse({ sku: "a" }).success, true);
  assert.equal(schema.safeParse({ sku: 1 }).success, false);
});

// Compile-time only: the stored output and the in-memory CandidateOutput must stay the same shape.
type StoredOutput = Extract<CaseResult, { status: "completed" }>["output"];
export const storedToMemory = (o: StoredOutput): CandidateOutput<JsonValue> => o;
export const memoryToStored = (o: CandidateOutput<JsonValue>): StoredOutput => o;
