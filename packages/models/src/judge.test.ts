import assert from "node:assert/strict";
import { test } from "node:test";
import { createJudge } from "./judge.ts";
import type { ModelClient, ModelTurn, ToolDefinition } from "./model-candidate.ts";

const criteria = [
  { id: "c1", text: "States the fee as an amount" },
  { id: "c2", text: "Says which policy the fee comes from" },
];
const item = { question: "What does cancelling cost?", note: "The fee is 300 EUR", answer: "It costs 300 EUR.", criteria };
const usage = { inputTokens: 200, outputTokens: 50 };

const records = (verdicts: unknown): Partial<ModelTurn> => ({
  toolRequests: [{ id: "call-1", name: "record_verdicts", args: { verdicts } as never }],
  stop: "tools",
});

/** A stand-in model that gives one reply, and keeps what it was told. */
function replying(turn: Partial<ModelTurn>) {
  const told: { system?: string; tools?: ToolDefinition[]; messages: unknown[] } = { messages: [] };
  const client: ModelClient = {
    model: "scripted-judge",
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
  return { judge: createJudge(client), told };
}

test("the judge is shown the question, the note, the answer and every criterion by its id", async () => {
  const { judge, told } = replying(records([]));
  await judge(item);

  assert.match(told.system!, /^You check an answer against a list of criteria\./);
  assert.deepEqual(told.messages, [
    {
      text: [
        "Question:\nWhat does cancelling cost?",
        "Note about the right answer:\nThe fee is 300 EUR",
        "Answer to check:\nIt costs 300 EUR.",
        "Criteria:\n- [c1] States the fee as an amount\n- [c2] Says which policy the fee comes from",
      ].join("\n\n"),
    },
  ]);
  assert.deepEqual(told.tools!.map((tool) => tool.name), ["record_verdicts"]);
  const parameters = told.tools![0]!.parameters as { properties: { verdicts: { items: { properties: { criterion: unknown } } } } };
  assert.deepEqual(parameters.properties.verdicts.items.properties.criterion, { type: "string", enum: ["c1", "c2"] });
});

test("a question without a note says so, in place of leaving a gap", async () => {
  const { judge, told } = replying(records([]));
  await judge({ ...item, note: undefined });
  assert.match((told.messages[0] as { text: string }).text, /\n\nNote about the right answer:\nnone\n\n/);
});

test("each verdict comes back by criterion, with its reason and what the call used", async () => {
  const { judge } = replying(
    records([
      { criterion: "c1", met: true, reason: "It names 300 EUR." },
      { criterion: "c2", met: false, reason: "No policy is mentioned." },
    ]),
  );
  const judgement = await judge(item);

  assert.deepEqual(judgement.verdicts, {
    c1: { met: true, reason: "It names 300 EUR." },
    c2: { met: false, reason: "No policy is mentioned." },
  });
  assert.equal(judgement.model, "scripted-judge");
  assert.deepEqual(judgement.usage, usage);
  assert.ok(judgement.durationMs >= 0);
});

test("a criterion the judge skipped is missing, and one it made up is dropped", async () => {
  const { judge } = replying(
    records([
      { criterion: "c1", met: true, reason: "It names 300 EUR." },
      { criterion: "c9", met: true, reason: "The answer is friendly." },
    ]),
  );
  assert.deepEqual((await judge(item)).verdicts, { c1: { met: true, reason: "It names 300 EUR." } });
});

test("a judge that does not record verdicts fails; nothing is assumed in its place", async () => {
  const failing: Partial<ModelTurn>[] = [
    { text: "Both criteria are met." },
    { ...records([{ criterion: "c1", met: "yes", reason: "It names 300 EUR." }]) },
    { ...records([{ criterion: "c1", met: true, reason: "It names 300 EUR." }]), stop: "truncated" },
    { stop: "refused" },
  ];
  for (const turn of failing) {
    await assert.rejects(replying(turn).judge(item), /^Error: the judge did not record its verdicts$/);
  }
});
