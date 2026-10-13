/**
 * Where a person's agents, tests and results live: plain files in one folder.
 * The folder is kept out of git, because it holds their own instructions.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const agentSchema = z.strictObject({
  name: z.string().min(1),
  /** Oldest first. A version is never changed once saved, so a result always says what it tested. */
  versions: z
    .array(
      z.strictObject({
        version: z.number().int().positive(),
        model: z.string().min(1),
        instructions: z.string().min(1),
        savedAt: z.iso.datetime(),
      }),
    )
    .min(1),
});

const testSchema = z.strictObject({
  name: z.string().min(1),
  judgeModel: z.string().min(1),
  questions: z
    .array(z.strictObject({ id, text: z.string().min(1), note: z.string().min(1).optional() }))
    .min(1),
  criteria: z.array(z.strictObject({ id, text: z.string().min(1), mustHave: z.boolean() })).min(1),
  savedAt: z.iso.datetime(),
});

export type Agent = z.infer<typeof agentSchema>;
export type AgentVersion = Agent["versions"][number];
export type Test = z.infer<typeof testSchema>;

/** Something the person entered that cannot be saved as it is. The message is shown next to the form. */
export class InputError extends Error {}

export interface AgentDraft {
  name: string;
  model: string;
  instructions: string;
}

export interface TestDraft {
  name: string;
  judgeModel: string;
  questions: { text: string; note?: string | undefined }[];
  criteria: { text: string; mustHave: boolean }[];
}

export class Workspace {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get runsDir(): string {
    return join(this.dir, "runs");
  }

  agents(): { id: string; agent: Agent }[] {
    return this.#list("agents").map((agentId) => ({ id: agentId, agent: this.agent(agentId)! }));
  }

  agent(agentId: string): Agent | undefined {
    return this.#read("agents", agentId, agentSchema);
  }

  /** Saves a new agent, or a new version of an existing one. Saving unchanged instructions adds nothing. */
  saveAgent(agentId: string | undefined, draft: AgentDraft, now: Date = new Date()): { id: string; version: number } {
    const name = draft.name.trim();
    const instructions = draft.instructions.trim();
    if (!name) throw new InputError("Give the agent a name.");
    if (!instructions) throw new InputError("Write the agent's instructions.");

    const existing = agentId === undefined ? undefined : this.agent(agentId);
    const latest = existing?.versions.at(-1);
    if (existing && latest && latest.model === draft.model && latest.instructions === instructions) {
      this.#write("agents", agentId!, { ...existing, name });
      return { id: agentId!, version: latest.version };
    }
    const version = (latest?.version ?? 0) + 1;
    const saved: Agent = {
      name,
      versions: [...(existing?.versions ?? []), { version, model: draft.model, instructions, savedAt: now.toISOString() }],
    };
    const savedId = existing ? agentId! : this.#freeId("agents", name);
    this.#write("agents", savedId, agentSchema.parse(saved));
    return { id: savedId, version };
  }

  tests(): { id: string; test: Test }[] {
    return this.#list("tests").map((testId) => ({ id: testId, test: this.test(testId)! }));
  }

  test(testId: string): Test | undefined {
    return this.#read("tests", testId, testSchema);
  }

  saveTest(testId: string | undefined, draft: TestDraft, now: Date = new Date()): string {
    const name = draft.name.trim();
    const questions = draft.questions.map((q) => ({ text: q.text.trim(), note: q.note?.trim() })).filter((q) => q.text);
    const criteria = draft.criteria.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
    if (!name) throw new InputError("Give the test a name.");
    if (questions.length === 0) throw new InputError("Add at least one example question.");
    if (criteria.length === 0) throw new InputError("Say what a good answer looks like, in at least one sentence.");
    if (!criteria.some((c) => c.mustHave)) throw new InputError("Mark at least one criterion as a must-have.");

    const saved: Test = {
      name,
      judgeModel: draft.judgeModel,
      questions: questions.map((q, i) => ({ id: `q${i + 1}`, text: q.text, ...(q.note && { note: q.note }) })),
      criteria: criteria.map((c, i) => ({ id: `c${i + 1}`, text: c.text, mustHave: c.mustHave })),
      savedAt: now.toISOString(),
    };
    const savedId = testId !== undefined && this.test(testId) ? testId : this.#freeId("tests", name);
    this.#write("tests", savedId, testSchema.parse(saved));
    return savedId;
  }

  #list(kind: string): string[] {
    const dir = join(this.dir, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  }

  #read<T>(kind: string, itemId: string, schema: z.ZodType<T>): T | undefined {
    const file = join(this.dir, kind, `${itemId}.json`);
    if (!id.safeParse(itemId).success || !existsSync(file)) return undefined;
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  #write(kind: string, itemId: string, value: unknown): void {
    mkdirSync(join(this.dir, kind), { recursive: true });
    writeFileSync(join(this.dir, kind, `${itemId}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  /** A file name made from the name, with a number added if it is taken. */
  #freeId(kind: string, name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
    const taken = new Set(this.#list(kind));
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

/**
 * Reads example questions from a block of text: one per line, with an optional
 * note about the right answer after a tab (as pasted from two spreadsheet
 * columns) or after " | ".
 */
export function parseQuestions(text: string): TestDraft["questions"] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const [question = "", ...rest] = line.includes("\t") ? line.split("\t") : line.split(" | ");
      const note = rest.join(" ").trim();
      return { text: question.trim(), ...(note && { note }) };
    })
    .filter((q) => q.text);
}

/** The reverse of parseQuestions, for showing a saved test in the form again. */
export function formatQuestions(questions: Test["questions"]): string {
  return questions.map((q) => (q.note ? `${q.text} | ${q.note}` : q.text)).join("\n");
}
