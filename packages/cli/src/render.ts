/** Turns a run and its summary into text. Formatting only: nothing here counts or scores. */
import type {
  CaseResult,
  CaseSide,
  Comparison,
  EvaluationRecord,
  Manifest,
  RunData,
  RunSummary,
} from "@agent-quality-lab/core";

export interface RunReport {
  manifest: Manifest;
  results: readonly CaseResult[];
  evaluations: readonly EvaluationRecord[];
  summary: RunSummary;
  notes?: readonly string[];
}

export function renderRun({ manifest, results, evaluations, summary, notes = [] }: RunReport): string {
  const { scenario, candidate, dataset } = manifest;
  const lines = [
    `${scenario.id} v${scenario.version} · ${candidate.id} v${candidate.version} · dataset ${dataset.name} · ${summary.cases} cases`,
    `run ${manifest.runId}`,
    "",
  ];

  const allNotes = candidate.deterministic
    ? notes
    : [...notes, "this candidate is not deterministic, so this run is one sample of its behaviour"];
  if (allNotes.length > 0) lines.push(...allNotes.map((note) => `note: ${note}`), "");

  const { completed, malformed_output, error, timeout } = summary.byStatus;
  const facts: [string, string][] = [
    [
      "execution",
      `${completed.length} completed, ${malformed_output.length} malformed output, ${error.length} error, ${timeout.length} timeout`,
    ],
    ["fallbacks", summary.fallbacks.length === 0 ? "none" : `${summary.fallbacks.length} (${summary.fallbacks.join(", ")})`],
  ];
  if (summary.durationMs) {
    facts.push(["duration", `median ${ms(summary.durationMs.median)}, max ${ms(summary.durationMs.max)}`]);
  }
  facts.push(["tool calls", `${summary.toolCalls.total}, of which ${summary.toolCalls.failed} failed`]);
  if (summary.tokens) {
    facts.push(["tokens", `${summary.tokens.input} in, ${summary.tokens.output} out`]);
  }
  lines.push(...table(facts), "");

  if (summary.evaluators.length === 0) {
    lines.push("no evaluations: the run has no cases or the scenario has no evaluators");
  } else {
    lines.push(
      ...table([
        ["evaluator", "version", "pass", "fail", "n/a", "evaluator error", "not evaluated"],
        ...summary.evaluators.map((e) => [
          e.id,
          e.version,
          `${e.pass.length}/${summary.cases}`,
          String(e.fail.length),
          String(e.notApplicable.length),
          String(e.error.length),
          String(e.notEvaluated.length),
        ]),
      ]),
    );
  }

  const notCompleted = results.filter((result) => result.status !== "completed").map(describeFailure);
  if (notCompleted.length > 0) lines.push("", "not completed", ...indent(table(notCompleted)));

  const failed = evaluations
    .filter(({ verdict }) => verdict.outcome === "fail" || verdict.outcome === "error")
    .map(({ caseId, evaluator, verdict }) => [
      caseId,
      verdict.outcome === "error" ? `${evaluator.id} (evaluator error)` : evaluator.id,
      verdict.detail ?? "",
    ]);
  if (failed.length > 0) lines.push("", "failed", ...indent(table(failed)));

  return lines.join("\n");
}

export function renderComparison(comparison: Comparison, a: RunData, b: RunData): string {
  const { scenario, dataset, cases } = comparison;
  const runs = [comparison.a, comparison.b];
  const lines = [
    `${scenario.id} v${scenario.version} · dataset ${dataset.name} · ${cases.length} cases`,
    "",
    ...table(runs.map((run, i) => ["AB"[i]!, `${run.candidate.id} v${run.candidate.version}`, `run ${run.runId}`])),
    "",
  ];

  const sampled = [...new Set(runs.filter((run) => !run.candidate.deterministic).map((run) => run.candidate.id))];
  if (sampled.length > 0) {
    lines.push(
      `note: not deterministic: ${sampled.join(", ")}. Each run is one sample, so a difference on a single case may be noise`,
      "",
    );
  }

  const row = (label: string, cell: (summary: RunSummary) => string) => [label, ...runs.map((run) => cell(run.summary))];
  const rows = [
    ["", "A", "B"],
    row("completed", (s) => `${s.byStatus.completed.length}/${s.cases}`),
    row("malformed output", (s) => String(s.byStatus.malformed_output.length)),
    row("error", (s) => String(s.byStatus.error.length)),
    row("timeout", (s) => String(s.byStatus.timeout.length)),
    row("fallbacks", (s) => String(s.fallbacks.length)),
    ...comparison.evaluators.map(({ id }) =>
      row(`${id} pass`, (s) => `${s.evaluators.find((e) => e.id === id)?.pass.length ?? 0}/${s.cases}`),
    ),
    row("median duration", (s) => (s.durationMs ? ms(s.durationMs.median) : "-")),
    row("max duration", (s) => (s.durationMs ? ms(s.durationMs.max) : "-")),
    row("tool calls", (s) => `${s.toolCalls.total} (${s.toolCalls.failed} failed)`),
  ];
  if (runs.some((run) => run.summary.tokens)) {
    rows.push(row("tokens", (s) => (s.tokens ? `${s.tokens.input} in, ${s.tokens.output} out` : "none reported")));
  }
  lines.push(...table(rows), "");

  const oneSided = comparison.evaluators.flatMap((evaluator) =>
    (
      [
        ["passes only in A", evaluator.onlyA],
        ["passes only in B", evaluator.onlyB],
        ["cannot be compared", evaluator.undetermined],
      ] as const
    )
      .filter(([, caseIds]) => caseIds.length > 0)
      .map(([label, caseIds]) => [evaluator.id, `${label} (${caseIds.length})`, caseIds.join(", ")]),
  );
  if (oneSided.length === 0) {
    lines.push("every evaluator passes on the same cases in both runs");
  } else {
    lines.push("by evaluator", ...indent(table(oneSided)));
  }

  const [resultsA, resultsB] = [a, b].map((run) => new Map(run.results.map((result) => [result.caseId, result])));
  const differing = cases.filter((c) => c.differences.length > 0);
  if (differing.length === 0) {
    lines.push("", "no case differs in status, output, verdicts or tool calls");
  } else {
    const sides = differing.flatMap((c) => [
      [c.caseId, "A", describeSide(resultsA!.get(c.caseId)!, c.a)],
      ["", "B", describeSide(resultsB!.get(c.caseId)!, c.b)],
    ]);
    lines.push("", `cases that differ (${differing.length} of ${cases.length})`, ...indent(table(sides)));
  }
  return lines.join("\n");
}

function describeSide(result: CaseResult, side: CaseSide): string {
  if (result.status !== "completed") return describeFailure(result)[1]!;
  const parts = [
    result.output.kind === "answer" ? `answer ${shorten(JSON.stringify(result.output.value))}` : "abstain",
    `${side.toolCalls} tool call${side.toolCalls === 1 ? "" : "s"}`,
  ];
  if (side.fallback) parts.push("fallback");
  const withOutcome = (outcome: string) =>
    Object.entries(side.verdicts)
      .filter(([, o]) => o === outcome)
      .map(([id]) => id);
  if (withOutcome("fail").length > 0) parts.push(`fails ${withOutcome("fail").join(" and ")}`);
  if (withOutcome("error").length > 0) parts.push(`evaluator error in ${withOutcome("error").join(" and ")}`);
  return parts.join(", ");
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function describeFailure(result: CaseResult): string[] {
  switch (result.status) {
    case "timeout":
      return [result.caseId, `timeout after ${ms(result.timeoutMs)}`];
    case "error":
      return [result.caseId, `error: ${result.error.message}`];
    case "malformed_output":
      return [result.caseId, `malformed output: ${result.problem}`];
    case "completed":
      return [result.caseId, "completed"];
  }
}

export function ms(value: number): string {
  return `${value < 10 ? value.toFixed(2) : value.toFixed(0)} ms`;
}

/** Pads every column but the last to the width of its longest cell. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2)))
      .join("")
      .trimEnd(),
  );
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `  ${line}`);
}
