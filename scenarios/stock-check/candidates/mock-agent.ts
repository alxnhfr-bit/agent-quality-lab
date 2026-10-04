/**
 * A stand-in for a model-backed agent, with no model behind it. It is
 * deliberately imperfect so that a run exercises every way a case can end:
 * it sometimes hangs, crashes, returns something malformed, repeats a lookup
 * or gets the answer wrong, and it guesses when a lookup fails.
 *
 * Which fault hits which case is drawn from the seed and the case input, so
 * the same seed always gives the same run and a different seed a different one.
 * The token counts it reports are made up.
 */
import type { Candidate, CandidateOutput } from "@agent-quality-lab/core";
import { getStock, type Input, type Output, type Stock } from "../scenario.ts";

const RATES = { hang: 0.08, crash: 0.08, repeatLookup: 0.2, malformed: 0.1, wrongAnswer: 0.15 };

export function mockAgent(seed: number): Candidate<Input, Output> {
  return {
    id: "mock-agent",
    version: "1",
    config: { seed, rates: RATES },
    deterministic: true,
    async run({ sku, quantity }, ctx) {
      const random = randomFor(`${seed}:${sku}:${quantity}`);

      const fault = random();
      if (fault < RATES.hang) return untilAborted(ctx.signal);
      if (fault < RATES.hang + RATES.crash) throw new Error("mock agent crashed");

      ctx.report({
        type: "model_call",
        model: "mock",
        usage: { inputTokens: 40 + sku.length, outputTokens: 12 },
      });

      let stock: Stock;
      try {
        stock = await getStock(ctx, sku);
      } catch (error) {
        ctx.report({
          type: "fallback",
          from: "getStock",
          to: "guess",
          reason: error instanceof Error ? error.message : String(error),
        });
        return { kind: "answer", value: { canFulfil: true } };
      }

      if (random() < RATES.repeatLookup) await getStock(ctx, sku);
      if (!stock.found) return { kind: "abstain", reason: `unknown item "${sku}"` };

      const canFulfil = stock.available >= quantity;
      if (random() < RATES.malformed) {
        return (canFulfil ? "yes" : "no") as unknown as CandidateOutput<Output>;
      }
      return {
        kind: "answer",
        value: { canFulfil: random() < RATES.wrongAnswer ? !canFulfil : canFulfil },
      };
    },
  };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** mulberry32, seeded with an FNV-1a hash of the key. */
function randomFor(key: string): () => number {
  let state = 2166136261;
  for (const char of key) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** With this seed the dev dataset ends in every possible way at least once; the scenario test pins it. */
export default mockAgent(49);
