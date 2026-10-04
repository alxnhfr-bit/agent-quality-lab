/**
 * Arithmetic the candidates share. They differ in what they do before it:
 * which records they trust, and how they place check-in on the clock.
 */
import type { CancellationPolicy, Money } from "../travel-shared/marketplace.ts";
import type { Input } from "./scenario.ts";

const HOUR = 3_600_000;

/** When the traveler means to cancel: now, or 24 hours on when the question says "tomorrow". */
export function cancelTime(input: Input): number {
  const asked = Date.parse(input.askedAt);
  return /\btomorrow\b/i.test(input.question) ? asked + 24 * HOUR : asked;
}

/** The fee a policy charges for cancelling at `cancelAt`, given when check-in is. Both are instants in milliseconds. */
export function feeAt(policy: CancellationPolicy, total: Money, cancelAt: number, checkIn: number): Money {
  const hoursBefore = (checkIn - cancelAt) / HOUR;
  const tier = [...policy.tiers]
    .sort((a, b) => b.untilHoursBeforeCheckIn - a.untilHoursBeforeCheckIn)
    .find((candidate) => hoursBefore >= candidate.untilHoursBeforeCheckIn);
  const percent = tier ? tier.feePercent : policy.afterwardsFeePercent;
  return { amount: Math.round(total.amount * percent) / 100, currency: total.currency };
}

export function describeFee(fee: Money): string {
  return fee.amount === 0 ? "free of charge" : `${fee.amount.toFixed(2)} ${fee.currency}`;
}
