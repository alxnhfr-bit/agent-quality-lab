/**
 * reddit-signal: sort a Reddit travel post into exactly one of five labels for
 * a travel app's product research. The task of the Reddit Signal Agent, and of
 * the Camunda and MCP projects built after it, which all measured themselves
 * against the same 91 hand-labelled posts.
 *
 * The posts are other people's writing, so they are not part of this
 * repository: `prepare.ts` reads them from the projects on this computer into
 * `datasets/`, which git ignores. See the README.
 *
 * The scenario tells a candidate nothing. Each project brought its own rubric
 * and prompt, recorded with its runs; this scenario holds only the posts, the
 * labels they should get, and the check.
 */
import { z } from "zod";
import { jsonSchemaOf, type Evaluator, type Scenario } from "@agent-quality-lab/core";

export const LABELS = [
  "competitor_mentions",
  "feature_gaps",
  "rising_destinations",
  "planning_pain_points",
  "no_signal",
] as const;

const inputSchema = z.strictObject({
  postId: z.string().min(1),
  subreddit: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  upvotes: z.number().int(),
  commentCount: z.number().int().nonnegative(),
});
const labelled = z.strictObject({ label: z.enum(LABELS) });

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof labelled>;
export type Expected = z.infer<typeof labelled>;

/**
 * Whether the post got the label it should have. A label outside the five never
 * reaches this check: it does not fit the output schema, so the case is
 * malformed output and counts as wrong.
 */
const label: Evaluator<Input, Output, Expected> = {
  id: "label",
  version: "1",
  evaluate(c, { output }) {
    if (!c.expected) return { outcome: "not_applicable", detail: "the post has no label" };
    if (output.kind === "abstain") {
      return { outcome: "fail", detail: "abstained, but every post gets one label, and no_signal is the label when nothing fits" };
    }
    const sorted = { expected: c.expected.label, actual: output.value.label };
    return sorted.actual === sorted.expected
      ? { outcome: "pass", label: sorted }
      : { outcome: "fail", label: sorted, detail: `labelled ${sorted.actual}, should be ${sorted.expected}` };
  },
};

const scenario: Scenario<Input, Output, Expected> = {
  id: "reddit-signal",
  version: "1",
  inputSchema,
  outputSchema: labelled,
  answerFormat: jsonSchemaOf(labelled),
  expectedSchema: labelled,
  instructions: "",
  datasets: {
    // The same 91 posts, labelled twice: version 2.1 relabels four of them.
    "labels-v2": new URL("./datasets/labels-v2.jsonl", import.meta.url),
    "labels-v2.1": new URL("./datasets/labels-v2.1.jsonl", import.meta.url),
  },
  evaluators: [label],
  timeoutMs: 120_000,
};

export default scenario;
