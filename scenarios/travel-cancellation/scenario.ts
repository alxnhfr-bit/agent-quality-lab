/**
 * travel-cancellation: what does it cost to cancel this booking?
 *
 * A traveler asks about cancelling a booking. The candidate is given the
 * question, the booking reference and the time the question was asked, and has
 * to look up the rest. The rules of the task:
 *
 * - The cancellation policy of the booked rate plan decides. What a property
 *   says about itself in its description decides nothing.
 * - A policy counts hours before check-in, and check-in is at the property's
 *   local time. "Tomorrow" means 24 hours after the question was asked.
 * - A fee of zero is a free cancellation.
 * - Escalate when the records were obtained but contradict each other: the rate
 *   plan says it is not refundable while its policy refunds, or the reverse.
 *   A human has to decide.
 * - Abstain when the facts cannot be obtained: there is no such booking, a
 *   record is incomplete, or a lookup stays unavailable.
 *
 * Every case has its own small world of records, and its own things that go
 * wrong, in its setup.
 */
import { z } from "zod";
import type { Evaluator, Scenario, TraceEvent } from "@agent-quality-lab/core";
import { TOOL_NAMES, createTools, moneySchema, worldSchema, type ToolName, type World } from "../travel-shared/marketplace.ts";

const SOURCES = { booking: "get_booking", rate_plan: "get_rate_plan", cancellation_policy: "get_cancellation_policy", property: "get_property" } as const;
const sourceSchema = z.enum(["booking", "rate_plan", "cancellation_policy", "property"]);

/** Lookups these questions never need. Calling one is wasted work. */
const UNNEEDED: readonly ToolName[] = ["get_payment", "get_promotion"];

const inputSchema = z.strictObject({
  question: z.string().min(1),
  bookingReference: z.string().min(1),
  askedAt: z.iso.datetime(),
});

const answerBase = {
  /** The records the answer relies on. */
  sources: z.array(sourceSchema),
  /** In words, for the traveler. Recorded, and not judged by any check yet. */
  explanation: z.string().min(1),
};
const outputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("cancellation_fee"), fee: moneySchema, ...answerBase }),
  z.strictObject({ decision: z.literal("escalate"), ...answerBase }),
]);

const expectedBase = {
  /** Lookups the candidate must at least have attempted. */
  requiredTools: z.array(z.enum(TOOL_NAMES)),
  maxToolCalls: z.number().int().positive(),
};
const expectedSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("cancellation_fee"), fee: moneySchema, ...expectedBase }),
  z.strictObject({ decision: z.literal("escalate"), ...expectedBase }),
  z.strictObject({ decision: z.literal("abstain"), ...expectedBase }),
]);

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;
export type Expected = z.infer<typeof expectedSchema>;
export type Source = z.infer<typeof sourceSchema>;

type Check = Evaluator<Input, Output, Expected, World>;
type ToolCall = Extract<TraceEvent, { type: "tool_call" }>;

const NO_EXPECTATION = { outcome: "not_applicable", detail: "the case has no expected behaviour" } as const;
const formatMoney = (money: z.infer<typeof moneySchema>) => `${money.amount.toFixed(2)} ${money.currency}`;
const toolCalls = (trace: readonly TraceEvent[]) => trace.filter((event): event is ToolCall => event.type === "tool_call");

/** Did the candidate come to the right kind of conclusion: a fee, an escalation, or an abstention? */
const outcome: Check = {
  id: "outcome",
  version: "1",
  evaluate(c, { output }) {
    if (!c.expected) return NO_EXPECTATION;
    const given = output.kind === "abstain" ? "abstain" : output.value.decision;
    if (given === c.expected.decision) return { outcome: "pass" };

    const did = { abstain: "abstained", escalate: "escalated", cancellation_fee: "stated a fee" }[given];
    const situation = {
      abstain: "the facts could not be obtained",
      escalate: "the records contradict each other and a human has to decide",
      cancellation_fee: "the records were available and agree",
    }[c.expected.decision];
    return { outcome: "fail", detail: `${did} although ${situation}` };
  },
};

/** Where a fee is due, is it the right amount in the right currency? */
const amount: Check = {
  id: "amount",
  version: "1",
  evaluate(c, { output }) {
    if (!c.expected) return NO_EXPECTATION;
    if (c.expected.decision !== "cancellation_fee") {
      return { outcome: "not_applicable", detail: "the case does not call for a fee" };
    }
    const expected = c.expected.fee;
    if (output.kind === "abstain" || output.value.decision !== "cancellation_fee") {
      return { outcome: "fail", detail: `stated no fee, expected ${formatMoney(expected)}` };
    }
    const { fee } = output.value;
    const right = Math.abs(fee.amount - expected.amount) < 0.005 && fee.currency === expected.currency;
    return right
      ? { outcome: "pass", value: fee.amount }
      : { outcome: "fail", value: fee.amount, detail: `stated ${formatMoney(fee)}, expected ${formatMoney(expected)}` };
  },
};

/** Is the answer backed by what was looked up? */
const evidence: Check = {
  id: "evidence",
  version: "1",
  evaluate(c, { output, trace }) {
    if (!c.expected) return NO_EXPECTATION;
    const calls = toolCalls(trace);
    const neverTried = c.expected.requiredTools.filter((tool) => !calls.some((call) => call.name === tool));
    if (neverTried.length > 0) return { outcome: "fail", detail: `never looked up: ${neverTried.join(", ")}` };

    const cited = output.kind === "answer" ? output.value.sources : [];
    const unbacked = cited.filter((source) => !calls.some((call) => call.name === SOURCES[source] && retrieved(call)));
    if (unbacked.length > 0) {
      return { outcome: "fail", detail: `cites a record it did not retrieve: ${unbacked.join(", ")}` };
    }
    return { outcome: "pass", value: cited.length };
  },
};

/** Did the candidate look up only what the question needs? */
const toolUse: Check = {
  id: "tool-use",
  version: "1",
  evaluate(c, { trace }) {
    if (!c.expected) return NO_EXPECTATION;
    const calls = toolCalls(trace);
    const fail = (detail: string) => ({ outcome: "fail" as const, value: calls.length, detail });

    const unneeded = [...new Set(calls.map((call) => call.name).filter((name) => UNNEEDED.includes(name as ToolName)))];
    if (unneeded.length > 0) return fail(`called ${unneeded.join(", ")}, which this question does not need`);
    if (calls.some((call) => call.name === "get_booking" && argument(call, "reference") !== c.input.bookingReference)) {
      return fail("looked up a booking other than the traveler's");
    }
    if (calls.length > c.expected.maxToolCalls) {
      return fail(`made ${calls.length} lookups where ${c.expected.maxToolCalls} is enough`);
    }
    return { outcome: "pass", value: calls.length };
  },
};

/** A lookup that came back with a record, as opposed to failing or finding nothing. */
function retrieved(call: ToolCall): boolean {
  const { result } = call;
  return typeof result === "object" && result !== null && !Array.isArray(result) && result.found === true;
}

function argument(call: ToolCall, name: string): unknown {
  const { args } = call;
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args[name] : undefined;
}

const scenario: Scenario<Input, Output, Expected, World> = {
  id: "travel-cancellation",
  version: "1",
  inputSchema,
  outputSchema,
  expectedSchema,
  setupSchema: worldSchema,
  datasets: { dev: new URL("./datasets/dev.jsonl", import.meta.url) },
  tools: (c) => createTools(c.setup!),
  evaluators: [outcome, amount, evidence, toolUse],
  timeoutMs: 500,
};

export default scenario;
