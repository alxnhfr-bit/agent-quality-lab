/**
 * Stand-ins for the models, for trying the interface without calling anything
 * or paying anything. The answers and verdicts they give mean nothing, and the
 * interface says so wherever it shows them.
 */
import type { ModelClient, ModelTurn } from "@agent-quality-lab/models";
import type { Models } from "./runs.ts";

/** The name a run records in place of a model when a stand-in answered. */
export const DEMO_MODEL = "demo";

const usage = { inputTokens: 120, outputTokens: 40 };

export function demoModels(): Models {
  const client: ModelClient = {
    model: DEMO_MODEL,
    settings: { provider: "demo" },
    start({ system, tools }) {
      return {
        async send(message): Promise<ModelTurn> {
          const text = "text" in message ? message.text : "";
          const record = tools.find((tool) => tool.name === "record_verdicts");
          if (!record) {
            // The instructions leave a mark on the answer, so that two versions of an agent can differ in a demo too.
            const answer = `Demo answer. No model was asked: "${text.slice(0, 80)}" (instructions of ${system.length} characters)`;
            return { text: answer, toolRequests: [], usage, stop: "done" };
          }
          // Asked as the judge: meets most criteria, in a way that depends only on the text, so a rerun agrees.
          const ids = [...text.matchAll(/^- \[([a-z0-9-]+)\]/gm)].map((match) => match[1]!);
          const mark = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
          const verdicts = ids.map((criterion, i) => ({
            criterion,
            met: (mark + i * 7) % 4 !== 0,
            reason: "Demo verdict. No judge read this answer.",
          }));
          return { text: "", toolRequests: [{ id: "demo", name: record.name, args: { verdicts } }], usage, stop: "tools" };
        },
      };
    },
  };
  return {
    client: () => client,
    prices: { currency: "USD", asOf: "2026-10-08", perMillionTokens: { [DEMO_MODEL]: { input: 0, output: 0 } } },
  };
}
