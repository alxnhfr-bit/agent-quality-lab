/**
 * An agent that is nothing but instructions and a model: it is asked a
 * question and answers in words. The instructions are its own, so two versions
 * of them are two candidates that can be compared on the same test.
 */
import type { Candidate, Prices } from "@agent-quality-lab/core";
import type { ModelClient } from "./model-candidate.ts";

export interface PromptAgentOptions {
  id: string;
  version: string;
  instructions: string;
  client: ModelClient;
  prices?: Prices;
}

export function promptAgent(options: PromptAgentOptions): Candidate<string, string> {
  const { client, instructions } = options;
  return {
    id: options.id,
    version: options.version,
    config: { model: client.model, settings: client.settings, instructions },
    deterministic: false,
    ...(options.prices && { prices: options.prices }),

    async run(question, ctx) {
      const started = performance.now();
      const reply = await client.start({ system: instructions, tools: [], signal: ctx.signal }).send({ text: question });
      ctx.report({
        type: "model_call",
        model: client.model,
        ...(reply.usage && { usage: reply.usage }),
        durationMs: Math.round(performance.now() - started),
      });
      if (reply.stop === "refused") {
        throw new Error(`the model declined to answer${reply.detail ? `: ${reply.detail}` : ""}`);
      }
      if (reply.stop === "truncated") throw new Error("the model's answer was cut off at its length limit");
      return { kind: "answer", value: reply.text };
    },
  };
}
