/**
 * The reference: a plain program that follows the task's rules step by step.
 * It retries a failed lookup once, escalates when the records contradict each
 * other, and abstains when it cannot get the facts. It never guesses.
 */
import type { Candidate, CandidateOutput } from "@agent-quality-lab/core";
import { lookups, type CancellationPolicy, type RatePlan } from "../../travel-shared/marketplace.ts";
import { cancelTime, describeFee, feeAt } from "../policy-math.ts";
import type { Input, Output, Source } from "../scenario.ts";

const ATTEMPTS = 2;

type Looked<T> = { failed: true } | { failed: false; record: T | null };

/** A lookup that fails is tried once more. Finding nothing is an answer, not a failure. */
async function look<T>(lookup: () => Promise<T | null>): Promise<Looked<T>> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return { failed: false, record: await lookup() };
    } catch {
      continue;
    }
  }
  return { failed: true };
}

const abstain = (reason: string): CandidateOutput<Output> => ({ kind: "abstain", reason });

/** A plan that calls itself non-refundable while its policy refunds, or the reverse. */
function contradicts(plan: RatePlan, policy: CancellationPolicy): boolean {
  const everRefunds = [...policy.tiers.map((tier) => tier.feePercent), policy.afterwardsFeePercent].some(
    (percent) => percent < 100,
  );
  return plan.refundable !== everRefunds;
}

const rules: Candidate<Input, Output> = {
  id: "rules",
  version: "1",
  config: { attempts: ATTEMPTS },
  deterministic: true,
  async run(input, ctx) {
    const sources: Source[] = [];

    const booking = await look(() => lookups.booking(ctx, input.bookingReference));
    if (booking.failed) return abstain("the booking could not be looked up");
    if (!booking.record) return abstain(`there is no booking ${input.bookingReference}`);
    sources.push("booking");

    const plan = await look(() => lookups.ratePlan(ctx, booking.record!.ratePlanId));
    if (plan.failed || !plan.record) return abstain("the booking's rate plan could not be looked up");
    sources.push("rate_plan");
    const policyId = plan.record.cancellationPolicyId;
    if (!policyId) return abstain("the rate plan has no cancellation policy on record");

    const policy = await look(() => lookups.cancellationPolicy(ctx, policyId));
    if (policy.failed || !policy.record) return abstain("the cancellation policy could not be looked up");
    sources.push("cancellation_policy");

    if (contradicts(plan.record, policy.record)) {
      const says = plan.record.refundable ? "refundable" : "not refundable";
      return {
        kind: "answer",
        value: {
          decision: "escalate",
          sources,
          explanation: `The rate plan is marked ${says}, but its cancellation policy says otherwise. A colleague needs to check which one applies.`,
        },
      };
    }

    const property = await look(() => lookups.property(ctx, booking.record!.propertyId));
    if (property.failed || !property.record) return abstain("the property could not be looked up");
    sources.push("property");

    // Check-in is at the property's local time, so its offset from UTC belongs in the instant.
    const { checkInTime, utcOffset } = property.record;
    const checkIn = Date.parse(`${booking.record.checkIn}T${checkInTime}:00${utcOffset}`);
    const fee = feeAt(policy.record, booking.record.total, cancelTime(input), checkIn);
    return {
      kind: "answer",
      value: {
        decision: "cancellation_fee",
        fee,
        sources,
        explanation: `Under the cancellation policy of your ${plan.record.name}, cancelling at that time is ${describeFee(fee)}.`,
      },
    };
  },
};

export default rules;
