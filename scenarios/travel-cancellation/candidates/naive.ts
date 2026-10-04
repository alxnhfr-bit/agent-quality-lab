/**
 * A plain program with four typical mistakes, each of which is wrong only on
 * some cases:
 *
 * 1. It reads check-in times as UTC, ignoring the property's own time zone.
 * 2. It trusts the property's description: if that promises free cancellation,
 *    it says the cancellation is free.
 * 3. It never escalates. Contradicting records do not stop it.
 * 4. It never retries. One failed lookup and it gives up.
 *
 * It does not guess and it does not look up anything it has no use for.
 */
import type { Candidate, CandidateOutput } from "@agent-quality-lab/core";
import { lookups } from "../../travel-shared/marketplace.ts";
import { cancelTime, describeFee, feeAt } from "../policy-math.ts";
import type { Input, Output, Source } from "../scenario.ts";

const abstain = (reason: string): CandidateOutput<Output> => ({ kind: "abstain", reason });

const naive: Candidate<Input, Output> = {
  id: "naive",
  version: "1",
  config: null,
  deterministic: true,
  async run(input, ctx) {
    const sources: Source[] = ["booking", "rate_plan", "cancellation_policy", "property"];
    try {
      const booking = await lookups.booking(ctx, input.bookingReference);
      if (!booking) return abstain(`there is no booking ${input.bookingReference}`);
      const plan = await lookups.ratePlan(ctx, booking.ratePlanId);
      if (!plan?.cancellationPolicyId) return abstain("the rate plan has no cancellation policy on record");
      const policy = await lookups.cancellationPolicy(ctx, plan.cancellationPolicyId);
      const property = await lookups.property(ctx, booking.propertyId);
      if (!policy || !property) return abstain("a record is missing");

      const promisedFree = /free cancellation/i.test(property.description);
      const checkIn = Date.parse(`${booking.checkIn}T${property.checkInTime}:00Z`);
      const fee = promisedFree
        ? { amount: 0, currency: booking.total.currency }
        : feeAt(policy, booking.total, cancelTime(input), checkIn);
      return {
        kind: "answer",
        value: { decision: "cancellation_fee", fee, sources, explanation: `Cancelling at that time is ${describeFee(fee)}.` },
      };
    } catch {
      return abstain("a lookup failed");
    }
  },
};

export default naive;
