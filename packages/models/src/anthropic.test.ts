import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { CandidateUnavailable } from "@agent-quality-lab/core";
import haiku from "../../../candidates/haiku.ts";
import opus from "../../../candidates/opus.ts";
import sonnet from "../../../candidates/sonnet.ts";
import { ANTHROPIC_PRICES, anthropic } from "./anthropic.ts";

// Nothing in this file reaches the network: the SDK client is replaced by one that answers from a script.

type Reply = Pick<Anthropic.Message, "content" | "stop_reason" | "usage"> & Partial<Anthropic.Message>;

const reply = (content: unknown[], stop_reason: string, extra: object = {}): Reply =>
  ({
    content,
    stop_reason,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: null },
    ...extra,
  }) as unknown as Reply;

function fake(replies: Reply[]) {
  const requests: { params: Record<string, unknown>; options: { signal?: AbortSignal } }[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>, options: { signal?: AbortSignal }) => {
        requests.push({ params: structuredClone(params), options });
        return replies.shift();
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, requests };
}

const tools = [{ name: "lookup", description: "Looks things up.", parameters: { type: "object", properties: {} } }];
const signal = new AbortController().signal;

test("a request carries the model, the instructions, the tools and the conversation so far", async () => {
  const { client, requests } = fake([reply([{ type: "text", text: "Hello." }], "end_turn")]);
  const conversation = anthropic({ model: "claude-haiku-4-5", client }).start({ system: "Be brief.", tools, signal });
  const turn = await conversation.send({ text: "Hi" });

  assert.deepEqual(requests[0]!.params, {
    model: "claude-haiku-4-5",
    max_tokens: 16000,
    system: "Be brief.",
    tools: [{ name: "lookup", description: "Looks things up.", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(requests[0]!.options.signal, signal);
  assert.deepEqual(turn, {
    text: "Hello.",
    toolRequests: [],
    usage: { inputTokens: 120, outputTokens: 30 },
    stop: "done",
  });
});

test("the effort setting is sent only when one is given", async () => {
  const { client, requests } = fake([reply([], "end_turn"), reply([], "end_turn")]);
  await anthropic({ model: "claude-opus-5-5", effort: "medium", client }).start({ system: "", tools, signal }).send({ text: "Hi" });
  await anthropic({ model: "claude-haiku-4-5", client }).start({ system: "", tools, signal }).send({ text: "Hi" });

  assert.deepEqual(requests[0]!.params.output_config, { effort: "medium" });
  assert.equal("output_config" in requests[1]!.params, false);
});

test("a reply goes back into the history untouched, and tool results follow in one message", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const first = [
    thinking,
    { type: "tool_use", id: "tu_1", name: "lookup", input: { id: "a" } },
    { type: "tool_use", id: "tu_2", name: "lookup", input: { id: "b" } },
  ];
  const { client, requests } = fake([reply(first, "tool_use"), reply([{ type: "text", text: "Done." }], "end_turn")]);
  const conversation = anthropic({ model: "claude-opus-5-5", client }).start({ system: "", tools, signal });

  const turn = await conversation.send({ text: "Look up a and b" });
  assert.equal(turn.stop, "tools");
  assert.deepEqual(turn.toolRequests, [
    { id: "tu_1", name: "lookup", args: { id: "a" } },
    { id: "tu_2", name: "lookup", args: { id: "b" } },
  ]);

  await conversation.send({
    toolResults: [
      { id: "tu_1", content: '{"found":true}', isError: false },
      { id: "tu_2", content: "service unavailable", isError: true },
    ],
  });
  assert.deepEqual(requests[1]!.params.messages, [
    { role: "user", content: "Look up a and b" },
    { role: "assistant", content: first },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: '{"found":true}' },
        { type: "tool_result", tool_use_id: "tu_2", content: "service unavailable", is_error: true },
      ],
    },
  ]);
});

test("a refusal and a cut-off reply are passed on as what they are", async () => {
  const { client } = fake([
    reply([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "" } }),
    reply([{ type: "text", text: "Half a" }], "max_tokens"),
  ]);
  const model = anthropic({ model: "claude-opus-5-5", client });

  const refused = await model.start({ system: "", tools, signal }).send({ text: "Hi" });
  assert.deepEqual([refused.stop, refused.detail], ["refused", "cyber"]);
  const cut = await model.start({ system: "", tools, signal }).send({ text: "Hi" });
  assert.equal(cut.stop, "truncated");
});

test("tokens read from or written to a cache are kept apart from ordinary input", async () => {
  const cached = reply([], "end_turn", {
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 80 },
  });
  const { client } = fake([cached]);
  const turn = await anthropic({ model: "claude-opus-5-5", client }).start({ system: "", tools, signal }).send({ text: "Hi" });
  assert.deepEqual(turn.usage, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 80 });
});

test("the three model candidates name a model that has a price, and loading them calls nothing", () => {
  const described = [haiku, sonnet, opus].map((candidate) => {
    const config = candidate.config as { model: string; settings: object };
    return [candidate.id, config.model, config.settings, candidate.prices === ANTHROPIC_PRICES];
  });
  assert.deepEqual(described, [
    ["haiku", "claude-haiku-4-5", { provider: "anthropic", maxTokens: 16000 }, true],
    ["sonnet", "claude-sonnet-5-5", { provider: "anthropic", maxTokens: 16000, effort: "medium" }, true],
    ["opus", "claude-opus-5-5", { provider: "anthropic", maxTokens: 16000, effort: "medium" }, true],
  ]);
  for (const [, model] of described) assert.ok(ANTHROPIC_PRICES.perMillionTokens[model as string]);
});

test("a setup problem makes the candidate unavailable; a failed request stays a failure of the case", async () => {
  const failing = (error: unknown) => {
    const client = { messages: { create: async () => Promise.reject(error) } } as unknown as Pick<Anthropic, "messages">;
    return anthropic({ model: "claude-haiku-4-5", client }).start({ system: "", tools, signal }).send({ text: "Hi" });
  };
  const headers = new Headers();

  // What the SDK raises when no credentials are set up: an error that never reached the API.
  await assert.rejects(failing(new Error("Could not resolve authentication method.")), CandidateUnavailable);
  await assert.rejects(failing(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers)), CandidateUnavailable);
  await assert.rejects(failing(new Anthropic.NotFoundError(404, undefined, "model: no-such-model", headers)), CandidateUnavailable);

  await assert.rejects(failing(new Anthropic.RateLimitError(429, undefined, "slow down", headers)), Anthropic.RateLimitError);
  await assert.rejects(failing(new Anthropic.APIConnectionError({ message: "socket hang up" })), Anthropic.APIConnectionError);
  await assert.rejects(failing(new Anthropic.APIUserAbortError()), Anthropic.APIUserAbortError);
});
