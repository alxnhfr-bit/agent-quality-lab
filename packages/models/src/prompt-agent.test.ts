import assert from "node:assert/strict";
import { test } from "node:test";
import { runCase, type Case } from "@agent-quality-lab/core";
import { z } from "zod";
import type { ModelClient, ModelTurn, ToolDefinition } from "./model-candidate.ts";
import { promptAgent } from "./prompt-agent.ts";

const scenario = { instructions: "", answerFormat: { type: "string" }, outputSchema: z.string(), timeoutMs: 1000 };
const c: Case<string, never> = { id: "q1", input: "Can I cancel for free?" };
const usage = { inputTokens: 100, outputTokens: 10 };

/** A stand-in model that gives one reply, and keeps what it was told. */
function replying(turn: Partial<ModelTurn>) {
  const told: { system?: string; tools?: ToolDefinition[]; messages: unknown[] } = { messages: [] };
  const client: ModelClient = {
    model: "scripted",
    settings: { provider: "test" },
    start({ system, tools }) {
      told.system = system;
      told.tools = tools;
      return {
        async send(message) {
          told.messages.push(message);
          return { text: "", toolRequests: [], usage, stop: "done", ...turn };
        },
      };
    },
  };
  return { agent: promptAgent({ id: "helper", version: "v2", instructions: "Be brief.", client }), told };
}

test("the model gets the agent's instructions and the question, and its words are the answer", async () => {
  const { agent, told } = replying({ text: "Yes, until Friday." });
  const result = await runCase(scenario, agent, c);

  assert.equal(told.system, "Be brief.");
  assert.deepEqual(told.tools, []);
  assert.deepEqual(told.messages, [{ text: "Can I cancel for free?" }]);
  assert.ok(result.status === "completed");
  assert.deepEqual(result.output, { kind: "answer", value: "Yes, until Friday." });
  assert.deepEqual(
    result.trace.map(({ type, source, ...rest }) => [type, source, "model" in rest && rest.model, "usage" in rest && rest.usage]),
    [["model_call", "reported", "scripted", usage]],
  );
});

test("the instructions and the model are recorded with the run, so two versions never look the same", () => {
  const { agent } = replying({});
  assert.equal(agent.id, "helper");
  assert.equal(agent.version, "v2");
  assert.equal(agent.deterministic, false);
  assert.deepEqual(agent.config, { model: "scripted", settings: { provider: "test" }, instructions: "Be brief." });
});

test("a refusal or a cut-off reply is a failed case, never an answer", async () => {
  const refused = await runCase(scenario, replying({ stop: "refused", detail: "cyber" }).agent, c);
  assert.ok(refused.status === "error");
  assert.equal(refused.error.message, "the model declined to answer: cyber");
  assert.equal(refused.trace.length, 1, "the call that was paid for is still recorded");

  const truncated = await runCase(scenario, replying({ text: "Yes, unt", stop: "truncated" }).agent, c);
  assert.ok(truncated.status === "error");
  assert.equal(truncated.error.message, "the model's answer was cut off at its length limit");
});
