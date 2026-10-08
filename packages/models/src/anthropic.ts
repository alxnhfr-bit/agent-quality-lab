/**
 * Talks to Claude models through the Anthropic API. The only file in the lab
 * that knows this provider.
 *
 * It never lets another model answer in a model's place: a refusal is passed on
 * as a refusal, so a run only ever measures the model it names.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CandidateUnavailable, type JsonValue, type Prices } from "@agent-quality-lab/core";
import type { ModelClient, ModelTurn } from "./model-candidate.ts";

export interface AnthropicOptions {
  model: string;
  /** The most one reply may be, thinking included. */
  maxTokens?: number;
  /** How much effort the model puts in. Left out for models that do not take the setting. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** For tests: anything with the SDK client's `messages.create`. */
  client?: Pick<Anthropic, "messages">;
}

/**
 * List prices in US dollars per million tokens. Reading from or writing to a
 * cache has its own prices, which are not listed: the lab does not use caching,
 * and a call that used it would be counted as not priced.
 */
export const ANTHROPIC_PRICES: Prices = {
  currency: "USD",
  asOf: "2026-09-25",
  perMillionTokens: {
    "claude-haiku-4-5": { input: 1, output: 5 },
    "claude-sonnet-5-5": { input: 2, output: 10 },
    "claude-opus-5-5": { input: 4, output: 20 },
  },
};

/**
 * A problem with how the lab is set up, not with one request: credentials that
 * are missing or were turned down, or a model that does not exist. Every case
 * would fail the same way.
 *
 * Anything that is not an API error never reached the API at all, which is how
 * the SDK reports missing credentials. Failed, timed-out and aborted requests
 * are API errors and stay failures of the one case.
 */
function isSetupProblem(error: unknown): boolean {
  return (
    !(error instanceof Anthropic.APIError) ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError
  );
}

const STOP: Record<string, ModelTurn["stop"]> = {
  end_turn: "done",
  stop_sequence: "done",
  tool_use: "tools",
  max_tokens: "truncated",
  refusal: "refused",
};

export function anthropic(options: AnthropicOptions): ModelClient {
  const maxTokens = options.maxTokens ?? 16000;
  let sdk = options.client;

  return {
    model: options.model,
    settings: { provider: "anthropic", maxTokens, ...(options.effort && { effort: options.effort }) },

    start({ system, tools, signal }) {
      // Created on first use, so credentials are only needed once a case actually runs.
      sdk ??= new Anthropic();
      const client = sdk;
      const messages: Anthropic.MessageParam[] = [];

      return {
        async send(message) {
          messages.push({
            role: "user",
            content:
              "text" in message
                ? message.text
                : // Every result of one turn goes back in one message.
                  message.toolResults.map((result) => ({
                    type: "tool_result" as const,
                    tool_use_id: result.id,
                    content: result.content,
                    ...(result.isError && { is_error: true }),
                  })),
          });

          const response = await client.messages
            .create(
              {
                model: options.model,
                max_tokens: maxTokens,
                system,
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                })),
                messages: [...messages],
                ...(options.effort && { output_config: { effort: options.effort } }),
              },
              { signal },
            )
            .catch((error: unknown) => {
              throw isSetupProblem(error)
                ? new CandidateUnavailable(`the Anthropic API could not be used: ${(error as Error).message}`)
                : error;
            });
          // The reply goes back into the history exactly as it came, thinking included.
          messages.push({ role: "assistant", content: response.content });

          const { usage } = response;
          return {
            text: response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
            toolRequests: response.content.flatMap((block) =>
              block.type === "tool_use" ? [{ id: block.id, name: block.name, args: block.input as JsonValue }] : [],
            ),
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              ...(usage.cache_read_input_tokens && { cacheReadTokens: usage.cache_read_input_tokens }),
              ...(usage.cache_creation_input_tokens && { cacheWriteTokens: usage.cache_creation_input_tokens }),
            },
            stop: STOP[response.stop_reason ?? ""] ?? "done",
            ...(response.stop_reason === "refusal" &&
              response.stop_details?.category && { detail: response.stop_details.category }),
          };
        },
      };
    },
  };
}
