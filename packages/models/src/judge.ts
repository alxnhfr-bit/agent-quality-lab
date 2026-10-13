/**
 * A judge that is a model: it reads one answer and decides, criterion by
 * criterion, whether the answer meets it, with one sentence of reasoning each.
 * The criteria are plain sentences that somebody wrote; the judge adds nothing
 * of its own to them.
 */
import type { JsonValue, Usage } from "@agent-quality-lab/core";
import { z } from "zod";
import type { ModelClient } from "./model-candidate.ts";

export interface Criterion {
  id: string;
  text: string;
}

export interface Judgement {
  /** By criterion id. A criterion the judge skipped is missing, never assumed met. */
  verdicts: Record<string, { met: boolean; reason: string }>;
  model: string;
  usage?: Usage;
  durationMs: number;
}

export type Judge = (item: {
  question: string;
  /** What the person who wrote the test knows about the right answer, if anything. */
  note?: string | undefined;
  answer: string;
  criteria: readonly Criterion[];
}) => Promise<Judgement>;

/** Changes whenever the judge's wording does, so verdicts from different wordings are never mixed. */
export const JUDGE_VERSION = "1";

const RECORD = "record_verdicts";

const INSTRUCTIONS = `You check an answer against a list of criteria. You did not write the answer.

For each criterion, decide whether the answer meets it.
- Judge what the answer says, not what it may have meant.
- If a note about the right answer is given, take the note as true.
- A criterion is met or it is not. When in doubt, it is not met.

Then call the ${RECORD} tool once, with one entry per criterion: whether it is met, and one sentence saying why. Write the sentence for someone who has not read the answer.`;

const recorded = z.object({
  verdicts: z.array(z.object({ criterion: z.string(), met: z.boolean(), reason: z.string() })),
});

export function createJudge(client: ModelClient, timeoutMs = 120_000): Judge {
  return async ({ question, note, answer, criteria }) => {
    const tool = {
      name: RECORD,
      description: "Records your verdict on every criterion. Call it once.",
      parameters: {
        type: "object",
        properties: {
          verdicts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                criterion: { type: "string", enum: criteria.map((c) => c.id) },
                met: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["criterion", "met", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["verdicts"],
        additionalProperties: false,
      } satisfies JsonValue,
    };
    const message = [
      `Question:\n${question}`,
      `Note about the right answer:\n${note?.trim() || "none"}`,
      `Answer to check:\n${answer}`,
      `Criteria:\n${criteria.map((c) => `- [${c.id}] ${c.text}`).join("\n")}`,
    ].join("\n\n");

    const started = performance.now();
    const reply = await client
      .start({ system: INSTRUCTIONS, tools: [tool], signal: AbortSignal.timeout(timeoutMs) })
      .send({ text: message });
    const durationMs = Math.round(performance.now() - started);

    const call = reply.toolRequests.find((request) => request.name === RECORD);
    const parsed = recorded.safeParse(call?.args);
    if (reply.stop === "refused" || reply.stop === "truncated" || !parsed.success) {
      throw new Error("the judge did not record its verdicts");
    }
    const known = new Set(criteria.map((c) => c.id));
    const verdicts: Judgement["verdicts"] = {};
    for (const { criterion, met, reason } of parsed.data.verdicts) {
      if (known.has(criterion)) verdicts[criterion] = { met, reason };
    }
    return { verdicts, model: client.model, ...(reply.usage && { usage: reply.usage }), durationMs };
  };
}
