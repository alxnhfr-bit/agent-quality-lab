import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prices, TraceEvent, Usage } from "./artifact.ts";
import { costOf } from "./cost.ts";

const prices: Prices = {
  currency: "USD",
  asOf: "2026-09-25",
  perMillionTokens: {
    small: { input: 1, output: 5 },
    large: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
};
const call = (model: string, usage?: Usage): TraceEvent => ({
  seq: 0,
  source: "reported",
  type: "model_call",
  model,
  ...(usage && { usage }),
});

test("a call costs its tokens at the price of its model", () => {
  const trace = [
    call("small", { inputTokens: 2000, outputTokens: 400 }),
    call("large", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 200 }),
  ];
  // small: 2000 * 1 + 400 * 5 = 4000; large: 1000 * 4 + 100 * 20 + 5000 * 0.2 + 200 * 5 = 8000; per million.
  assert.deepEqual(costOf(trace, prices), { total: 0.012, unpriced: 0 });
});

test("a call that cannot be priced is counted, not treated as free", () => {
  const trace = [
    call("small", { inputTokens: 1_000_000, outputTokens: 0 }),
    call("unknown", { inputTokens: 1000, outputTokens: 10 }),
    call("small"),
    // The small model has no price for cached input.
    call("small", { inputTokens: 10, outputTokens: 10, cacheReadTokens: 500 }),
  ];
  assert.deepEqual(costOf(trace, prices), { total: 1, unpriced: 3 });
  assert.deepEqual(costOf(trace, undefined), { total: 0, unpriced: 4 });
});

test("a trace without model calls costs nothing", () => {
  const lookup: TraceEvent = { seq: 0, source: "observed", type: "tool_call", name: "lookup", args: null, result: 1 };
  assert.deepEqual(costOf([lookup], prices), { total: 0, unpriced: 0 });
});
