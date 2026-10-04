/** A plain program: look the item up, retry once if the lookup fails, never guess. */
import type { Candidate } from "@agent-quality-lab/core";
import { getStock, type Input, type Output, type Stock } from "../scenario.ts";

const ATTEMPTS = 2;

const baseline: Candidate<Input, Output> = {
  id: "baseline",
  version: "1",
  config: { attempts: ATTEMPTS },
  deterministic: true,
  async run({ sku, quantity }, ctx) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let stock: Stock;
      try {
        stock = await getStock(ctx, sku);
      } catch {
        continue;
      }
      if (!stock.found) return { kind: "abstain", reason: `unknown item "${sku}"` };
      return { kind: "answer", value: { canFulfil: stock.available >= quantity } };
    }
    return { kind: "abstain", reason: "the inventory service is unavailable" };
  },
};

export default baseline;
