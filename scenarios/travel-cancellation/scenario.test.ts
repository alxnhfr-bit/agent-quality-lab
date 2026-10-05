import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRun,
  runCase,
  type Candidate,
  type CaseResult,
  type RunContext,
  type TraceEvent,
} from "@agent-quality-lab/core";
import { loadDataset } from "@agent-quality-lab/core/store";
import naive from "./candidates/naive.ts";
import rules from "./candidates/rules.ts";
import scenario, { type Input, type Output } from "./scenario.ts";

const dataset = await loadDataset(scenario, "dev");
const caseById = (id: string) => dataset.cases.find((c) => c.id === id)!;

type Run = Pick<Candidate<Input, Output>, "run">;

async function runAll(candidate: Run): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of dataset.cases) results.push(await runCase(scenario, candidate, c));
  return results;
}

/** For each check, the cases a candidate does not pass. */
async function failures(candidate: Run): Promise<Record<string, string[]>> {
  const failed: Record<string, string[]> = { outcome: [], amount: [], evidence: [], "tool-use": [] };
  for (const { caseId, evaluator, verdict } of await evaluateRun(scenario, dataset.cases, await runAll(candidate))) {
    if (verdict.outcome !== "pass" && verdict.outcome !== "not_applicable") failed[evaluator.id]!.push(caseId);
  }
  return failed;
}

/** The verdicts of one candidate on one case, by check. */
async function verdictsOn(caseId: string, candidate: Run) {
  const c = caseById(caseId);
  const records = await evaluateRun(scenario, [c], [await runCase(scenario, candidate, c)]);
  return Object.fromEntries(records.map((record) => [record.evaluator.id, record.verdict]));
}

const lookupsIn = (trace: readonly TraceEvent[]) =>
  trace.flatMap((event) => (event.type === "tool_call" ? [`${event.name}${event.error === undefined ? "" : " failed"}`] : []));

test("the dev dataset has twenty cases, each with its own world", () => {
  const decisions = dataset.cases.map((c) => c.expected?.decision);
  assert.equal(dataset.cases.length, 20);
  assert.equal(decisions.filter((d) => d === "cancellation_fee").length, 14);
  assert.equal(decisions.filter((d) => d === "escalate").length, 2);
  assert.equal(decisions.filter((d) => d === "abstain").length, 4);
  assert.ok(dataset.cases.every((c) => c.setup !== undefined));
});

test("the reference candidate passes every check on every case", async () => {
  assert.deepEqual(await failures(rules), { outcome: [], amount: [], evidence: [], "tool-use": [] });
});

test("the naive candidate fails exactly where its four mistakes bite", async () => {
  assert.deepEqual(await failures(naive), {
    // It never escalates, and it gives up after one failed lookup.
    outcome: ["saver-rate-with-refunding-policy", "refundable-rate-with-no-refund-policy", "policy-lookup-fails-once"],
    // It reads check-in times as UTC, and it believes the property page.
    amount: [
      "time-zone-ahead-of-utc",
      "time-zone-behind-utc",
      "page-promises-free-saver-rate",
      "page-promises-free-standard-rate",
      "policy-lookup-fails-once",
    ],
    evidence: ["policy-lookup-fails-once"],
    "tool-use": [],
  });
});

test("the lookups go wrong the way a case's setup says", async () => {
  const lookups = async (caseId: string) => lookupsIn((await runCase(scenario, rules, caseById(caseId))).trace);

  assert.deepEqual(await lookups("policy-lookup-fails-once"), [
    "get_booking",
    "get_rate_plan",
    "get_cancellation_policy failed",
    "get_cancellation_policy",
    "get_property",
  ]);
  assert.deepEqual(await lookups("policy-service-down"), [
    "get_booking",
    "get_rate_plan",
    "get_cancellation_policy failed",
    "get_cancellation_policy failed",
  ]);
  // A lookup that answers with something that is not a record does not fail; the answer is just unusable.
  assert.deepEqual(await lookups("rate-plan-lookup-garbled"), ["get_booking", "get_rate_plan", "get_rate_plan"]);
  assert.deepEqual(await lookups("unknown-booking"), ["get_booking"]);
});

test("a right fee stated without looking anything up passes amount and fails evidence", async () => {
  const guesser: Run = {
    run: async () => ({
      kind: "answer",
      value: { decision: "cancellation_fee", fee: { amount: 0, currency: "EUR" }, sources: [], explanation: "It is free." },
    }),
  };
  const verdicts = await verdictsOn("free-well-ahead", guesser);
  assert.equal(verdicts.outcome?.outcome, "pass");
  assert.equal(verdicts.amount?.outcome, "pass");
  assert.deepEqual(verdicts.evidence, {
    outcome: "fail",
    detail: "never looked up: get_booking, get_rate_plan, get_cancellation_policy, get_property",
  });
});

test("citing a record that was never retrieved fails evidence", async () => {
  const overclaiming: Run = {
    run: async (input, ctx) => {
      await ctx.tools.get_booking!({ reference: input.bookingReference });
      await ctx.tools.get_rate_plan!({ id: "RP-FLEX" });
      await ctx.tools.get_cancellation_policy!({ id: "POL-FLEX48" });
      await ctx.tools.get_property!({ id: "P-NOWHERE" });
      return {
        kind: "answer",
        value: {
          decision: "cancellation_fee",
          fee: { amount: 0, currency: "EUR" },
          sources: ["booking", "property"],
          explanation: "It is free.",
        },
      };
    },
  };
  assert.deepEqual((await verdictsOn("free-well-ahead", overclaiming)).evidence, {
    outcome: "fail",
    detail: "cites a record it did not retrieve: property",
  });
});

test("looking up what the question does not need fails tool-use", async () => {
  const curious = (extra: (ctx: Parameters<Run["run"]>[1]) => Promise<unknown>): Run => ({
    run: async (input, ctx) => {
      await extra(ctx);
      return rules.run(input, ctx);
    },
  });

  const payment = await verdictsOn("free-well-ahead", curious((ctx) => ctx.tools.get_payment!({ bookingReference: "BK-1001" })));
  assert.deepEqual(payment["tool-use"], {
    outcome: "fail",
    value: 5,
    detail: "called get_payment, which this question does not need",
  });

  const snooping = await verdictsOn("free-well-ahead", curious((ctx) => ctx.tools.get_booking!({ reference: "BK-9999" })));
  assert.equal(snooping["tool-use"]?.detail, "looked up a booking other than the traveler's");

  // The rest of the answer is still right: the checks are independent of each other.
  assert.equal(payment.amount?.outcome, "pass");
});

test("a lookup with arguments the tool does not accept is recorded as a failed call", async () => {
  const sloppy: Run = {
    run: async (_input, ctx) => {
      await ctx.tools.get_booking!({ ref: "BK-1001" }).catch(() => {});
      return { kind: "abstain", reason: "could not look it up" };
    },
  };
  const { trace } = await runCase(scenario, sloppy, caseById("free-well-ahead"));
  assert.deepEqual(lookupsIn(trace), ["get_booking failed"]);
});

test("a candidate is told the task's rules and what each lookup is for", async () => {
  let ctx: RunContext | undefined;
  const looking: Run = {
    run: async (_input, given) => {
      ctx = given;
      return { kind: "abstain", reason: "just looking" };
    },
  };
  await runCase(scenario, looking, caseById("free-well-ahead"));

  for (const rule of [/decides the fee/, /property's own time zone/, /24 hours after/, /Escalate to a human/, /Abstain when/]) {
    assert.match(ctx!.instructions, rule);
  }
  assert.deepEqual(Object.keys(ctx!.tools), [
    "get_booking",
    "get_rate_plan",
    "get_cancellation_policy",
    "get_property",
    "get_payment",
    "get_promotion",
  ]);
  for (const tool of Object.values(ctx!.tools)) {
    assert.match(tool.description, /^Looks up .* Returns \{found: true, record\}, or \{found: false\}/);
  }
  assert.deepEqual(ctx!.tools.get_booking!.parameters, {
    type: "object",
    properties: { reference: { type: "string", description: "The booking reference, such as BK-1001" } },
    required: ["reference"],
    additionalProperties: false,
  });
});

test("what a candidate is told does not give away which lookups a question needs", async () => {
  let ctx: RunContext | undefined;
  await runCase(
    scenario,
    {
      run: async (_input, given) => {
        ctx = given;
        return { kind: "abstain", reason: "just looking" };
      },
    },
    caseById("free-well-ahead"),
  );
  const told = [ctx!.instructions, ...Object.values(ctx!.tools).map((tool) => tool.description)].join("\n");
  assert.doesNotMatch(told, /not need|unneeded|unnecessary|do not call|get_payment|get_promotion/i);
});
