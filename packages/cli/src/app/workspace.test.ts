import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InputError, Workspace, formatQuestions, parseQuestions } from "./workspace.ts";

const workspace = () => new Workspace(mkdtempSync(join(tmpdir(), "aql-workspace-")));
const at = (iso: string) => new Date(iso);
const agentDraft = { name: "Cancellation helper", model: "claude-haiku-4-5", instructions: "Always state the fee." };
const testDraft = {
  name: "Cancellation questions",
  judgeModel: "claude-opus-5-5",
  questions: [{ text: "Can I cancel for free?", note: "Yes, until Friday" }, { text: "What does it cost?" }],
  criteria: [
    { text: "States the fee as an amount", mustHave: true },
    { text: "Is polite", mustHave: false },
  ],
};

test("an agent is saved under a file name made from its name, as version 1", () => {
  const w = workspace();
  const saved = w.saveAgent(undefined, { ...agentDraft, instructions: "  Always state the fee.\n" }, at("2026-10-08T10:00:00Z"));

  assert.deepEqual(saved, { id: "cancellation-helper", version: 1 });
  assert.deepEqual(w.agent("cancellation-helper"), {
    name: "Cancellation helper",
    versions: [{ version: 1, model: "claude-haiku-4-5", instructions: "Always state the fee.", savedAt: "2026-10-08T10:00:00.000Z" }],
  });
  assert.deepEqual(readdirSync(join(w.dir, "agents")), ["cancellation-helper.json"]);
});

test("changing the instructions or the model adds a version, and the earlier ones stay as they were", () => {
  const w = workspace();
  const { id } = w.saveAgent(undefined, agentDraft, at("2026-10-08T10:00:00Z"));
  const before = w.agent(id)!.versions[0];

  assert.equal(w.saveAgent(id, { ...agentDraft, instructions: "Always state the fee and the policy." }).version, 2);
  assert.equal(w.saveAgent(id, { ...agentDraft, instructions: "Always state the fee and the policy.", model: "claude-sonnet-5-5" }).version, 3);

  const { versions } = w.agent(id)!;
  assert.deepEqual(versions.map((v) => [v.version, v.model]), [
    [1, "claude-haiku-4-5"],
    [2, "claude-haiku-4-5"],
    [3, "claude-sonnet-5-5"],
  ]);
  assert.deepEqual(versions[0], before);
});

test("saving an agent unchanged adds nothing, and a new name alone is not a new version", () => {
  const w = workspace();
  const { id } = w.saveAgent(undefined, agentDraft);

  assert.deepEqual(w.saveAgent(id, agentDraft), { id, version: 1 });
  assert.deepEqual(w.saveAgent(id, { ...agentDraft, name: "Refund helper" }), { id, version: 1 });
  assert.equal(w.agent(id)!.name, "Refund helper");
  assert.equal(w.agent(id)!.versions.length, 1);
});

test("two agents with the same name are kept apart", () => {
  const w = workspace();
  assert.equal(w.saveAgent(undefined, agentDraft).id, "cancellation-helper");
  assert.equal(w.saveAgent(undefined, agentDraft).id, "cancellation-helper-2");
  assert.equal(w.saveAgent(undefined, { ...agentDraft, name: "?!" }).id, "untitled");
  assert.deepEqual(w.agents().map(({ id }) => id), ["cancellation-helper", "cancellation-helper-2", "untitled"]);
});

test("an agent without a name or without instructions is not saved, and the reason is one a person can act on", () => {
  const w = workspace();
  assert.throws(() => w.saveAgent(undefined, { ...agentDraft, name: "  " }), new InputError("Give the agent a name."));
  assert.throws(() => w.saveAgent(undefined, { ...agentDraft, instructions: "\n" }), new InputError("Write the agent's instructions."));
  assert.deepEqual(w.agents(), []);
});

test("a test is saved with numbered questions and criteria, and empty rows are left out", () => {
  const w = workspace();
  const id = w.saveTest(
    undefined,
    {
      ...testDraft,
      questions: [...testDraft.questions, { text: "  " }],
      criteria: [{ text: "", mustHave: true }, ...testDraft.criteria],
    },
    at("2026-10-08T10:00:00Z"),
  );

  assert.equal(id, "cancellation-questions");
  assert.deepEqual(w.test(id), {
    name: "Cancellation questions",
    judgeModel: "claude-opus-5-5",
    questions: [
      { id: "q1", text: "Can I cancel for free?", note: "Yes, until Friday" },
      { id: "q2", text: "What does it cost?" },
    ],
    criteria: [
      { id: "c1", text: "States the fee as an amount", mustHave: true },
      { id: "c2", text: "Is polite", mustHave: false },
    ],
    savedAt: "2026-10-08T10:00:00.000Z",
  });
});

test("saving a test again replaces it, under the same file name", () => {
  const w = workspace();
  const id = w.saveTest(undefined, testDraft);
  assert.equal(w.saveTest(id, { ...testDraft, name: "Refund questions", questions: [{ text: "Can I get a refund?" }] }), id);
  assert.deepEqual(w.tests().map(({ id: testId, test }) => [testId, test.name, test.questions.length]), [[id, "Refund questions", 1]]);
});

test("a test needs a name, a question, and a must-have", () => {
  const w = workspace();
  const refused = (draft: Partial<typeof testDraft>, message: string) =>
    assert.throws(() => w.saveTest(undefined, { ...testDraft, ...draft }), new InputError(message));

  refused({ name: "" }, "Give the test a name.");
  refused({ questions: [{ text: " " }] }, "Add at least one example question.");
  refused({ criteria: [] }, "Say what a good answer looks like, in at least one sentence.");
  refused({ criteria: [{ text: "Is polite", mustHave: false }] }, "Mark at least one criterion as a must-have.");
  assert.deepEqual(w.tests(), []);
});

test("questions are read one per line, with a note after a tab or after a bar", () => {
  const typed = "Can I cancel for free? | Yes, until Friday\n\n  What does it cost?  \r\nIs it refundable?\tNo\tnot at this rate\n";
  const questions = parseQuestions(typed);

  assert.deepEqual(questions, [
    { text: "Can I cancel for free?", note: "Yes, until Friday" },
    { text: "What does it cost?" },
    { text: "Is it refundable?", note: "No not at this rate" },
  ]);
  const saved = questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));
  assert.equal(formatQuestions(saved), "Can I cancel for free? | Yes, until Friday\nWhat does it cost?\nIs it refundable? | No not at this rate");
  assert.deepEqual(parseQuestions(formatQuestions(saved)), questions);
});

test("only names the lab gave out are looked up, so nothing outside the folder is read", () => {
  const w = workspace();
  const { id } = w.saveAgent(undefined, agentDraft);
  assert.ok(readFileSync(join(w.dir, "agents", `${id}.json`), "utf8"));

  assert.equal(w.agent(`../agents/${id}`), undefined);
  assert.equal(w.agent("no-such-agent"), undefined);
  assert.equal(w.test("../../etc/passwd"), undefined);
});
