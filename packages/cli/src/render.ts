/** Turns a run and its summary into text. Formatting only: nothing here counts or scores. */
import type { CaseResult, EvaluationRecord, Manifest, RunSummary } from "@agent-quality-lab/core";

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
    lines.push("no evaluations: either no case completed or the scenario has no evaluators");
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

function ms(value: number): string {
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
