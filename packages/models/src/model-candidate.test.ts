import assert from "node:assert/strict";
import { test } from "node:test";
import { runCase, type Case, type Tool } from "@agent-quality-lab/core";
import { z } from "zod";
import { modelCandidate, type ModelClient, type ModelTurn, type ToolDefinition } from "./model-candidate.ts";

const outputSchema = z.strictObject({ n: z.number() });
const tool = (run: Tool["run"], description: string): Tool => ({ description, parameters: { type: "object" }, run });
const scenario = {
  instructions: "Double the number you are given.",
  answerFormat: { type: "object", properties: { n: { type: "number" } } },
  outputSchema,
  timeoutMs: 1000,
  tools: (): Record<string, Tool> => ({
    double: tool(async (args) => ({ n: (args as { n: number }).n * 2 }), "Doubles a number."),
    broken: tool(async () => {
      throw new Error("unavailable");
    }, "Always fails."),
  }),
};
const c: Case<{ n: number }, never> = { id: "c1", input: { n: 2 } };

const usage = { inputTokens: 100, outputTokens: 10 };
const asks = (...names: string[]): ModelTurn => ({
  text: "",
  toolRequests: names.map((name, i) => ({ id: `call-${name}-${i}`, name, args: { n: 2 } })),
  usage,
  stop: "tools",
});
const submits = (answer: unknown): ModelTurn => ({
  text: "",
  toolRequests: [{ id: "final", name: "submit_answer", args: { answer } as never }],
  usage,
  stop: "tools",
});

/** A stand-in model that says what it is scripted to say, and keeps what it was told. */
function scripted(turns: ModelTurn[]) {
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
          const turn = turns.shift();
          if (!turn) throw new Error("the script ran out");
          return turn;
        },
      };
    },
  };
  return { candidate: modelCandidate({ id: "scripted", client, maxTurns: 3 }), told };
}

test("the model is told the task, the request, the tools and how to hand over its result", async () => {
  const { candidate, told } = scripted([submits({ n: 4 })]);
  const result = await runCase(scenario, candidate, c);

  assert.match(told.system!, /^Double the number you are given\.\n\nHow to respond:/);
  assert.match(told.system!, /call the submit_answer tool/);
  assert.deepEqual(told.tools!.map((t) => [t.name, t.description]).slice(0, 2), [
    ["double", "Doubles a number."],
    ["broken", "Always fails."],
  ]);
  assert.deepEqual(told.tools!.map((t) => t.name).slice(2), ["submit_answer", "abstain"]);
  assert.deepEqual(told.tools![2]!.parameters, {
    type: "object",
    properties: { answer: scenario.answerFormat },
    required: ["answer"],
    additionalProperties: false,
  });
  assert.deepEqual(told.messages, [{ text: 'The request:\n{\n  "n": 2\n}' }]);
  assert.deepEqual(result.status === "completed" && result.output, { kind: "answer", value: { n: 4 } });
});

test("tools the model asks for run through the lab, and their results go back together", async () => {
  const { candidate, told } = scripted([asks("double", "double"), submits({ n: 4 })]);
  const result = await runCase(scenario, candidate, c);

  assert.deepEqual(told.messages[1], {
    toolResults: [
      { id: "call-double-0", content: '{"n":4}', isError: false },
      { id: "call-double-1", content: '{"n":4}', isError: false },
    ],
  });
  assert.deepEqual(
    result.trace.map((event) => [event.source, event.type]),
    [
      ["reported", "model_call"],
      ["observed", "tool_call"],
      ["observed", "tool_call"],
      ["reported", "model_call"],
    ],
  );
  const [first] = result.trace;
  assert.deepEqual(first?.type === "model_call" && [first.model, first.usage], ["scripted", usage]);
});

test("a tool that fails goes back to the model as a failure, and the model may abstain", async () => {
  const abstains: ModelTurn = {
    text: "",
    toolRequests: [{ id: "final", name: "abstain", args: { reason: "the tool is down" } }],
    stop: "tools",
  };
  const { candidate, told } = scripted([asks("broken"), abstains]);
  const result = await runCase(scenario, candidate, c);

  assert.deepEqual(told.messages[1], { toolResults: [{ id: "call-broken-0", content: "unavailable", isError: true }] });
  assert.deepEqual(result.status === "completed" && result.output, { kind: "abstain", reason: "the tool is down" });
});

test("asking for a tool that does not exist is recorded, and reported back as a failure", async () => {
  const { candidate, told } = scripted([asks("nope"), submits({ n: 4 })]);
  const result = await runCase(scenario, candidate, c);

  assert.deepEqual(told.messages[1], {
    toolResults: [{ id: "call-nope-0", content: "there is no tool named nope", isError: true }],
  });
  const [, call] = result.trace;
  assert.deepEqual(call?.type === "tool_call" && [call.source, call.name, call.error], [
    "reported",
    "nope",
    "there is no tool named nope",
  ]);
});

test("a model that stops without handing anything over leaves malformed output, with its words kept", async () => {
  const { candidate } = scripted([{ text: "The answer is 4.", toolRequests: [], usage, stop: "done" }]);
  const result = await runCase(scenario, candidate, c);
  assert.equal(result.status, "malformed_output");
  assert.equal(result.status === "malformed_output" && result.rawOutput, "The answer is 4.");
});

test("a result in the wrong shape is malformed output, with no second try", async () => {
  const { candidate, told } = scripted([submits({ n: "four" }), submits({ n: 4 })]);
  const result = await runCase(scenario, candidate, c);
  assert.equal(result.status, "malformed_output");
  assert.equal(told.messages.length, 1);
});

test("a refusal or a cut-off reply is an error, and nothing it asked for is run", async () => {
  for (const [stop, message] of [
    ["refused", /declined to continue: cyber/],
    ["truncated", /cut off at its length limit/],
  ] as const) {
    const { candidate } = scripted([{ ...asks("double"), stop, detail: "cyber" }]);
    const result = await runCase(scenario, candidate, c);
    assert.match(result.status === "error" ? result.error.message : "", message);
    assert.deepEqual(result.trace.map((event) => event.type), ["model_call"]);
  }
});

test("it gives up after its maximum number of calls, and what it spent stays on record", async () => {
  const { candidate } = scripted([asks("double"), asks("double"), asks("double"), submits({ n: 4 })]);
  const result = await runCase(scenario, candidate, c);
  assert.match(result.status === "error" ? result.error.message : "", /gave no result within 3 calls/);
  assert.equal(result.trace.filter((event) => event.type === "model_call").length, 3);
});

test("a scenario whose own tool is called submit_answer is refused", async () => {
  const { candidate } = scripted([submits({ n: 4 })]);
  const clashing = { ...scenario, tools: () => ({ submit_answer: tool(async () => 0, "A clash.") }) };
  const result = await runCase(clashing, candidate, c);
  assert.match(result.status === "error" ? result.error.message : "", /has a tool named submit_answer/);
});

test("the candidate records its model and settings, and does not claim to be deterministic", () => {
  const { candidate } = scripted([]);
  assert.deepEqual(candidate.config, { model: "scripted", settings: { provider: "test" }, maxTurns: 3 });
  assert.equal(candidate.deterministic, false);
});
