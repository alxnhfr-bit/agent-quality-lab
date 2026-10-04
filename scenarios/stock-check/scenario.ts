/**
 * stock-check: a synthetic scenario for proving the lab's plumbing.
 *
 * Task: given an item and a quantity, say whether the order can be fulfilled.
 * The only way to know is the `getStock` tool. The candidate must abstain when
 * the stock level cannot be established: the item is unknown, or the inventory
 * service stays unavailable. Guessing is wrong even when the guess is right.
 *
 * The inventory is fixed and part of the scenario version.
 */
import { z } from "zod";
import type { Evaluator, RunContext, Scenario, Tool } from "@agent-quality-lab/core";

const inputSchema = z.strictObject({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
});
const outputSchema = z.strictObject({ canFulfil: z.boolean() });
const expectedSchema = z.discriminatedUnion("behaviour", [
  z.strictObject({
    behaviour: z.literal("answer"),
    canFulfil: z.boolean(),
    maxToolCalls: z.number().int().positive(),
  }),
  z.strictObject({
    behaviour: z.literal("abstain"),
    maxToolCalls: z.number().int().positive(),
  }),
]);
const stockSchema = z.discriminatedUnion("found", [
  z.strictObject({ found: z.literal(true), available: z.number().int().nonnegative() }),
  z.strictObject({ found: z.literal(false) }),
]);

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;
export type Expected = z.infer<typeof expectedSchema>;
export type Stock = z.infer<typeof stockSchema>;

const STOCK: Record<string, number> = { kettle: 12, lamp: 0, desk: 3, chair: 40, mug: 25, sofa: 6 };

/** Lookups that fail before one succeeds. Infinity: the service never answers for this item. */
const FAILURES_BEFORE_SUCCESS: Record<string, number> = { mug: 1, sofa: Infinity };

function createTools(): Record<string, Tool> {
  const failures = new Map<string, number>();
  return {
    async getStock(args): Promise<Stock> {
      const { sku } = z.strictObject({ sku: z.string() }).parse(args);
      const failed = failures.get(sku) ?? 0;
      if (failed < (FAILURES_BEFORE_SUCCESS[sku] ?? 0)) {
        failures.set(sku, failed + 1);
        throw new Error("inventory service unavailable");
      }
      const available = STOCK[sku];
      return available === undefined ? { found: false } : { found: true, available };
    },
  };
}

/** Typed access to the `getStock` tool, for candidates. */
export async function getStock(ctx: RunContext, sku: string): Promise<Stock> {
  const tool = ctx.tools.getStock;
  if (!tool) throw new Error("the getStock tool is not available");
  return stockSchema.parse(await tool({ sku }));
}

const correctness: Evaluator<Input, Output, Expected> = {
  id: "correctness",
  version: "1",
  evaluate(c, { output }) {
    if (!c.expected) return { outcome: "not_applicable", detail: "the case has no expected behaviour" };
    if (c.expected.behaviour === "abstain") {
      return output.kind === "abstain"
        ? { outcome: "pass" }
        : { outcome: "fail", detail: "answered when the stock level could not be established" };
    }
    if (output.kind === "abstain") {
      return { outcome: "fail", detail: "abstained when the stock level could be established" };
    }
    return output.value.canFulfil === c.expected.canFulfil
      ? { outcome: "pass" }
      : { outcome: "fail", detail: `expected canFulfil to be ${c.expected.canFulfil}` };
  },
};

const toolUse: Evaluator<Input, Output, Expected> = {
  id: "tool-use",
  version: "1",
  evaluate(c, { output, trace }) {
    if (!c.expected) return { outcome: "not_applicable", detail: "the case has no expected behaviour" };
    const calls = trace.filter((event) => event.type === "tool_call");
    const fail = (detail: string) => ({ outcome: "fail" as const, value: calls.length, detail });

    if (calls.length === 0) return fail("produced a result without looking up the stock");
    if (calls.some((call) => call.name !== "getStock" || skuOf(call.args) !== c.input.sku)) {
      return fail("looked up something other than the requested item");
    }
    if (output.kind === "answer" && !calls.some((call) => call.result !== undefined)) {
      return fail("answered although no lookup succeeded");
    }
    if (calls.length > c.expected.maxToolCalls) {
      return fail(`made ${calls.length} lookups where ${c.expected.maxToolCalls} suffice`);
    }
    return { outcome: "pass", value: calls.length };
  },
};

function skuOf(args: unknown): unknown {
  return typeof args === "object" && args !== null && "sku" in args ? args.sku : undefined;
}

const scenario: Scenario<Input, Output, Expected> = {
  id: "stock-check",
  version: "1",
  inputSchema,
  outputSchema,
  expectedSchema,
  datasets: { dev: new URL("./datasets/dev.jsonl", import.meta.url) },
  tools: createTools,
  evaluators: [correctness, toolUse],
  timeoutMs: 250,
};

export default scenario;
