/**
 * A candidate that hands the task to a language model. It works for any
 * scenario, because everything it tells the model comes from the scenario: the
 * instructions, the tools and the shape of an answer.
 *
 * Nothing here knows about a particular model provider. Whatever talks to one
 * is a ModelClient.
 */
import type { Candidate, CandidateOutput, JsonValue, Prices, Usage } from "@agent-quality-lab/core";

export interface ToolDefinition {
  name: string;
  description: string;
  /** The arguments it accepts, as a JSON Schema object. */
  parameters: JsonValue;
}

export interface ToolRequest {
  id: string;
  name: string;
  args: JsonValue;
}

export interface ToolResult {
  /** The id of the request this answers. */
  id: string;
  content: string;
  isError: boolean;
}

/** What a model did when it was called once. */
export interface ModelTurn {
  text: string;
  toolRequests: ToolRequest[];
  usage?: Usage;
  /**
   * "done": it ended its turn. "tools": it wants tools run. "truncated": it hit
   * its length limit. "refused": it declined, with `detail` saying why if known.
   */
  stop: "done" | "tools" | "truncated" | "refused";
  detail?: string;
}

/** One conversation with a model. The client keeps the history in whatever form its provider needs. */
export interface ModelConversation {
  send(message: { text: string } | { toolResults: ToolResult[] }): Promise<ModelTurn>;
}

export interface ModelClient {
  /** The model's id, recorded with every call and used to look up its price. */
  model: string;
  /** Everything about how the model is called that could change what it does. Recorded with the run. */
  settings: JsonValue;
  start(setup: { system: string; tools: ToolDefinition[]; signal: AbortSignal }): ModelConversation;
}

export interface ModelCandidateOptions {
  id: string;
  version?: string;
  client: ModelClient;
  /** How often the model may be called for one case before the candidate gives up. */
  maxTurns?: number;
  prices?: Prices;
}

const SUBMIT = "submit_answer";
const ABSTAIN = "abstain";

/** How the model hands over its result. The same for every scenario and every model. */
const HOW_TO_RESPOND = `How to respond:
- When you have the result, call the ${SUBMIT} tool with it.
- If you conclude that you should not give a result, call the ${ABSTAIN} tool and say why.
- Call one of the two, once, as your last step. Do not give the result as plain text.`;

export function modelCandidate(options: ModelCandidateOptions): Candidate<unknown, unknown> {
  const { client } = options;
  const maxTurns = options.maxTurns ?? 12;

  return {
    id: options.id,
    version: options.version ?? "1",
    config: { model: client.model, settings: client.settings, maxTurns },
    deterministic: false,
    ...(options.prices && { prices: options.prices }),

    async run(input, ctx): Promise<CandidateOutput<unknown>> {
      for (const reserved of [SUBMIT, ABSTAIN]) {
        if (reserved in ctx.tools) throw new Error(`the scenario has a tool named ${reserved}, which this candidate needs for itself`);
      }
      const conversation = client.start({
        system: `${ctx.instructions}\n\n${HOW_TO_RESPOND}`,
        tools: [
          ...Object.entries(ctx.tools).map(([name, { description, parameters }]) => ({ name, description, parameters })),
          {
            name: SUBMIT,
            description: "Hands over your result. Call it once, when you are done.",
            parameters: {
              type: "object",
              properties: { answer: ctx.answerFormat },
              required: ["answer"],
              additionalProperties: false,
            },
          },
          {
            name: ABSTAIN,
            description: "Says that you are not giving a result, and why. Call it once, in place of submit_answer.",
            parameters: {
              type: "object",
              properties: { reason: { type: "string" } },
              required: ["reason"],
              additionalProperties: false,
            },
          },
        ],
        signal: ctx.signal,
      });

      let message: Parameters<ModelConversation["send"]>[0] = {
        text: `The request:\n${JSON.stringify(input, null, 2)}`,
      };
      for (let turn = 0; turn < maxTurns; turn++) {
        const started = performance.now();
        const reply = await conversation.send(message);
        ctx.report({
          type: "model_call",
          model: client.model,
          ...(reply.usage && { usage: reply.usage }),
          durationMs: Math.round(performance.now() - started),
        });

        // Checked before anything it asked for is run: a reply that was cut short may hold half a request.
        if (reply.stop === "refused") {
          throw new Error(`the model declined to continue${reply.detail ? `: ${reply.detail}` : ""}`);
        }
        if (reply.stop === "truncated") throw new Error("the model's reply was cut off at its length limit");

        // Its first hand-over ends the case. There is no second try at the format.
        const final = reply.toolRequests.find(({ name }) => name === SUBMIT || name === ABSTAIN);
        if (final) {
          const args = (final.args ?? {}) as Record<string, unknown>;
          return final.name === SUBMIT
            ? { kind: "answer", value: args.answer }
            : { kind: "abstain", reason: args.reason as string };
        }
        // It stopped without handing anything over. What it wrote is kept, as output the lab cannot use.
        if (reply.toolRequests.length === 0) return reply.text as never;

        const toolResults: ToolResult[] = [];
        for (const request of reply.toolRequests) {
          toolResults.push(await carryOut(request, ctx));
        }
        message = { toolResults };
      }
      throw new Error(`the model gave no result within ${maxTurns} calls`);
    },
  };
}

/** Runs one tool for the model. A failure goes back to the model as a failure, so it can react. */
async function carryOut(
  request: ToolRequest,
  ctx: Parameters<Candidate<unknown, unknown>["run"]>[1],
): Promise<ToolResult> {
  const tool = ctx.tools[request.name];
  if (!tool) {
    // The lab did not see this happen, since there was no tool to call; it would be invisible otherwise.
    const error = `there is no tool named ${request.name}`;
    ctx.report({ type: "tool_call", name: request.name, args: request.args, error });
    return { id: request.id, content: error, isError: true };
  }
  try {
    return { id: request.id, content: JSON.stringify(await tool(request.args)), isError: false };
  } catch (error) {
    return { id: request.id, content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
