/**
 * Works out what the model calls in a trace cost, from the token counts each
 * call carries and the prices recorded with the run. A call that cannot be
 * priced is counted, never assumed to be free.
 */
import type { Prices, TraceEvent } from "./artifact.ts";

export interface Cost {
  /** In the currency of the prices. */
  total: number;
  /** Model calls left out of the total: no token counts, or a model or token kind without a price. */
  unpriced: number;
}

export function costOf(trace: readonly TraceEvent[], prices: Prices | undefined): Cost {
  const cost: Cost = { total: 0, unpriced: 0 };
  for (const event of trace) {
    if (event.type !== "model_call") continue;
    const price = prices?.perMillionTokens[event.model];
    const usage = event.usage;
    const cacheRead = usage?.cacheReadTokens ?? 0;
    const cacheWrite = usage?.cacheWriteTokens ?? 0;
    if (
      !price ||
      !usage ||
      (cacheRead > 0 && price.cacheRead === undefined) ||
      (cacheWrite > 0 && price.cacheWrite === undefined)
    ) {
      cost.unpriced += 1;
      continue;
    }
    cost.total +=
      (usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        cacheRead * (price.cacheRead ?? 0) +
        cacheWrite * (price.cacheWrite ?? 0)) /
      1_000_000;
  }
  return cost;
}
