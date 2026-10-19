/**
 * Reads the Reddit Signal projects on this computer into the lab: the labelled
 * posts as datasets, and the stored answers of every full run as files that
 * `aql import` reads. Everything it writes goes to `datasets/` and `imports/`
 * next to this file, which git ignores. Nothing is called, and nothing in the
 * projects is changed.
 *
 *   node scenarios/reddit-signal/prepare.ts [--from <folder that holds the projects>]
 *
 * By default the projects are looked for next to the lab's own folder.
 * Answers are copied as the projects recorded them. Nothing is corrected:
 * a label outside the five stays as it was, and a post with no recorded
 * label becomes an error, so the lab counts both as wrong and says why.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ImportedAnswers, JsonValue } from "@agent-quality-lab/core";

type Candidate = ImportedAnswers["candidate"];

// --- Reading the projects' files ---------------------------------------------------

/** Reads CSV with a header row, as the projects write it: commas, double quotes, "" for a quote. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("the CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) rows.push([...row, field]);

  const [header, ...records] = rows.filter((r) => r.some((cell) => cell !== ""));
  if (!header) return [];
  return records.map((record, n) => {
    if (record.length !== header.length) {
      throw new Error(`row ${n + 2} has ${record.length} fields where the header has ${header.length}`);
    }
    return Object.fromEntries(header.map((name, i) => [name, record[i]!]));
  });
}

/** The labelled posts as a lab dataset: one case per post, tagged by whether the rubric quotes it. */
export function datasetFromLabels(csv: string): string {
  return parseCsv(csv)
    .map((row) => {
      const inRubric = { true: true, false: false }[row.in_rubric?.toLowerCase() ?? ""];
      if (inRubric === undefined) throw new Error(`post ${row.post_id}: in_rubric is "${row.in_rubric}", not True or False`);
      const record = {
        id: row.post_id,
        input: {
          postId: row.post_id,
          subreddit: row.subreddit,
          title: row.post_title,
          url: row.post_url,
          upvotes: whole(row.upvotes, "upvotes", row.post_id),
          commentCount: whole(row.comment_count, "comment_count", row.post_id),
        },
        expected: { label: row.true_bucket },
        // The rubric quotes these posts as examples, so a system that follows it was told their answer.
        tags: [inRubric ? "in-rubric" : "held-out"],
      };
      return `${JSON.stringify(record)}\n`;
    })
    .join("");
}

function whole(value: string | undefined, column: string, postId: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isInteger(n)) {
    throw new Error(`post ${postId}: ${column} is "${value}", not a whole number`);
  }
  return n;
}

/** Answers from a CSV of `post_id,bucket`, as the agent's own evaluation writes them. */
export function answersFromPredictions(csv: string, candidate: Candidate): ImportedAnswers {
  return {
    candidate,
    answers: parseCsv(csv).map((row) => ({ caseId: row.post_id!, answer: { label: row.bucket! } })),
  };
}

/** Answers from a results.jsonl of the Camunda and MCP runners: one post per line, with `predicted` and `error`. */
export function answersFromResults(jsonl: string, candidate: Candidate, startedAt?: string): ImportedAnswers {
  const answers = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const row = JSON.parse(line) as { post_id: string; predicted?: string | null; error?: string | null };
      if (row.error) return { caseId: row.post_id, error: row.error };
      if (row.predicted === null || row.predicted === undefined) {
        return { caseId: row.post_id, error: "the run recorded no label for this post" };
      }
      return { caseId: row.post_id, answer: { label: row.predicted } };
    });
  return { candidate, ...(startedAt && { startedAt }), answers };
}

/** "run-2026-07-23T18-26-12..." → "2026-07-23T18:26:12Z". The runners name their folders after the start in UTC. */
export function startOf(runFolder: string): string | undefined {
  const match = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(runFolder);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z` : undefined;
}

// --- Writing the lab's files -------------------------------------------------------

const POSTS = 91;

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const { values } = parseArgs({ options: { from: { type: "string" } } });
  const from = resolve(values.from ?? join(here, "..", "..", ".."));
  const project = (name: string) => {
    const dir = join(from, name);
    if (!existsSync(dir)) throw new Error(`no project "${name}" in ${from}; name the folder that holds it with --from`);
    return dir;
  };
  const agent = project("reddit-signal-agent");
  const camunda = project("camunda trial");
  const mcp = project("mcp-grounding");

  const datasets = join(here, "datasets");
  const imports = join(here, "imports");
  // Both folders are written by this script alone, so they are rebuilt from scratch.
  for (const dir of [datasets, imports]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(datasets, { recursive: true });

  const report: string[] = [];
  const write = (file: string, text: string, what: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    report.push(`  ${file.slice(here.length + 1)}  ${what}`);
  };

  // Labels: version 2 from the agent, version 2.1 from the Camunda project, which the MCP project copied.
  const v21 = readFileSync(join(camunda, "eval", "golden_set_v2_1.csv"), "utf8");
  if (readFileSync(join(mcp, "eval", "golden_set_v2_1.csv"), "utf8") !== v21) {
    throw new Error("the Camunda and MCP projects hold different copies of labels v2.1");
  }
  write(join(datasets, "labels-v2.jsonl"), datasetFromLabels(readFileSync(join(agent, "eval", "golden_set_v2_labeled.csv"), "utf8")), "labels v2");
  write(join(datasets, "labels-v2.1.jsonl"), datasetFromLabels(v21), "labels v2.1");

  // The agent: the run of its rewritten prompt. The earlier run's answers were never stored in the project.
  const predictions = join("eval", "predictions_v2.csv");
  const agentAnswers = answersFromPredictions(readFileSync(join(agent, predictions), "utf8"), {
    id: "signal-agent",
    version: "rubric-v2-prompt",
    config: {
      project: "reddit-signal-agent",
      file: predictions,
      ...commitOf(agent, predictions),
      model: "claude-haiku-4-5",
      reads: "subreddit, title, upvotes, comment count and the first 500 characters of the post text",
      requests: `all ${POSTS} posts in one request, as in production`,
      labels: "as the model wrote them, uncorrected",
    },
  });
  write(join(imports, "labels-v2", "signal-agent.json"), json(agentAnswers), `${agentAnswers.answers.length} answers`);

  const skipped: string[] = [];
  const runs = (dir: string) => readdirSync(join(dir, "eval", "results")).filter((name) => name.startsWith("run-")).sort();

  for (const run of runs(camunda)) {
    const file = join("eval", "results", run, "results.jsonl");
    const answers = answersFromResults(
      readFileSync(join(camunda, file), "utf8"),
      {
        id: "camunda",
        version: run,
        config: {
          project: "camunda trial",
          file,
          ...commitOf(camunda, file),
          model: "claude-sonnet-5",
          reads: "subreddit and title",
          requests: "one post at a time, as a Camunda process instance",
          tools: ["verify_place"],
        },
      },
      startOf(run),
    );
    if (answers.answers.length !== POSTS) skipped.push(`  camunda ${run}: ${answers.answers.length} of ${POSTS} posts`);
    else write(join(imports, "labels-v2.1", `camunda-${run}.json`), json(answers), `${POSTS} answers`);
  }

  for (const run of runs(mcp)) {
    const file = join("eval", "results", run, "results.jsonl");
    const settings = JSON.parse(readFileSync(join(mcp, "eval", "results", run, "run-config.json"), "utf8")) as Record<string, JsonValue>;
    const arm = /arm([A-Z])/.exec(String(settings.label))?.[1];
    if (!arm) throw new Error(`mcp-grounding ${run}: run-config.json names no arm`);
    const answers = answersFromResults(
      readFileSync(join(mcp, file), "utf8"),
      {
        id: `mcp-arm-${arm.toLowerCase()}`,
        version: run,
        config: {
          project: "mcp-grounding",
          file,
          ...commitOf(mcp, file),
          reads: "subreddit and title",
          requests: "one post at a time, through an MCP server",
          ...pick(settings, ["label", "model", "maxTokens", "temperature", "maxModelCalls", "rubricArm", "toolDescriptionId"]),
        },
      },
      typeof settings.startedAt === "string" ? settings.startedAt : startOf(run),
    );
    if (answers.answers.length !== POSTS) skipped.push(`  mcp ${run}: ${answers.answers.length} of ${POSTS} posts`);
    else write(join(imports, "labels-v2.1", `mcp-${run}.json`), json(answers), `${POSTS} answers`);
  }

  const lines = [`Read the projects in ${from}`, "", "Written:", ...report];
  if (skipped.length > 0) lines.push("", "Not written, because they cover only part of the posts:", ...skipped);
  lines.push(
    "",
    "Import them with:",
    "  for f in scenarios/reddit-signal/imports/labels-v2/*.json; do npx aql import reddit-signal \"$f\" --dataset labels-v2; done",
    "  for f in scenarios/reddit-signal/imports/labels-v2.1/*.json; do npx aql import reddit-signal \"$f\" --dataset labels-v2.1; done",
  );
  console.log(lines.join("\n"));
}

/** The commit that last changed a file, so an import says which recorded version it read. */
function commitOf(dir: string, file: string): { commit?: string } {
  try {
    const commit = execFileSync("git", ["-C", dir, "log", "-1", "--format=%h", "--", file], { encoding: "utf8" }).trim();
    return commit ? { commit } : {};
  } catch {
    return {};
  }
}

function pick(record: Record<string, JsonValue>, keys: string[]): Record<string, JsonValue> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]!]));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
