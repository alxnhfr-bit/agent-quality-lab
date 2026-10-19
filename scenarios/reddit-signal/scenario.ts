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
 * labels they should get, and the checks: the label, and for systems that had
 * the place check, whether they used it as their prompts said.
 */
import { z } from "zod";
import { jsonSchemaOf, type Evaluator, type Scenario, type TraceEvent } from "@agent-quality-lab/core";

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

/** The tool the Camunda and MCP projects gave their systems, which asks Google Places whether a place exists. */
export const PLACE_CHECK = "verify_place";

const lookups = (trace: readonly TraceEvent[]) =>
  trace.filter((event): event is Extract<TraceEvent, { type: "tool_call" }> => event.type === "tool_call");

/** Why a place check says nothing about a system: it could not check places, or nobody recorded whether it could. */
function withoutPlaceCheck(tools: readonly string[] | undefined) {
  if (tools?.includes(PLACE_CHECK)) return undefined;
  return {
    outcome: "not_applicable" as const,
    detail: tools === undefined ? "it is not known whether this system could check places" : "this system had no place check",
  };
}

/**
 * The tool policy of the Camunda and MCP prompts: a post is only called a
 * rising destination once a place in it has been confirmed to exist. Mirrors
 * the projects' own "predictions with required grounding".
 */
const verified: Evaluator<Input, Output, Expected> = {
  id: "verified",
  version: "1",
  readsToolCalls: true,
  evaluate(_c, { output, trace, tools }) {
    const cannot = withoutPlaceCheck(tools);
    if (cannot) return cannot;
    if (output.kind === "abstain" || output.value.label !== "rising_destinations") {
      return { outcome: "not_applicable", detail: "only a post labelled rising_destinations needs a confirmed place" };
    }
    const confirmed = lookups(trace).filter((call) => call.name === PLACE_CHECK && found(call.result));
    return confirmed.length > 0
      ? { outcome: "pass", value: confirmed.length }
      : { outcome: "fail", detail: "labelled rising_destinations without a confirmed place" };
  },
};

/**
 * The other half of the policy: a post with nothing in it gets no lookup at
 * all. Mirrors the projects' own "no_signal posts with zero tool calls".
 */
const restraint: Evaluator<Input, Output, Expected> = {
  id: "restraint",
  version: "1",
  readsToolCalls: true,
  evaluate(c, { trace, tools }) {
    const cannot = withoutPlaceCheck(tools);
    if (cannot) return cannot;
    if (c.expected?.label !== "no_signal") {
      return { outcome: "not_applicable", detail: "only a post that should be no_signal must get no lookup" };
    }
    const calls = lookups(trace);
    if (calls.length === 0) return { outcome: "pass", value: 0 };
    const asked = calls.flatMap((call) => {
      const place = typeof call.args === "object" && call.args !== null && "placeName" in call.args ? call.args.placeName : undefined;
      return typeof place === "string" ? [place] : [];
    });
    return {
      outcome: "fail",
      value: calls.length,
      detail: `looked up ${calls.length === 1 ? "a place" : `${calls.length} places`} on a post with nothing in it${asked.length > 0 ? `: ${asked.join(", ")}` : ""}`,
    };
  },
};

function found(result: unknown): boolean {
  return typeof result === "object" && result !== null && "found" in result && result.found === true;
}

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
  evaluators: [label, verified, restraint],
  timeoutMs: 120_000,
};

export default scenario;
