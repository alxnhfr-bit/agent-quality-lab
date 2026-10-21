/** Turns a run and its summary into text. Formatting only: nothing here counts or scores. */
import {
  MIN_RUNS,
  passRate,
  type CaseComparison,
  type CaseResult,
  type CaseSide,
  type Comparison,
  type EvaluationRecord,
  type LabelBreakdown,
  type Manifest,
  type Overview,
  type RunData,
  type Spread,
  type RunSummary,
  type SliceSummary,
  type Steadiness,
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
    `${scenario.id} ${versioned(scenario.version)} · ${candidate.id} ${versioned(candidate.version)} · dataset ${dataset.name} · ${summary.cases} cases`,
    `run ${manifest.runId}`,
    "",
  ];

  const allNotes = [
    ...(manifest.origin ? [imported(manifest.origin)] : []),
    ...notes,
    ...(candidate.deterministic ? [] : ["this candidate is not deterministic, so this run is one sample of its behaviour"]),
  ];
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
  facts.push([
    "tool calls",
    untraced({ manifest }) ? "not imported" : `${summary.toolCalls.total}, of which ${summary.toolCalls.failed} failed`,
  ]);
  if (summary.modelCalls > 0) facts.push(["model calls", String(summary.modelCalls)]);
  if (summary.tokens) {
    facts.push(["tokens", `${summary.tokens.input} in, ${summary.tokens.output} out`]);
  }
  if (summary.cost && manifest.prices) {
    facts.push([
      "cost",
      `${usd(summary.cost.total)} in total, ${usd(summary.cost.medianPerCase)} per case (median)${unpriced(summary)}, at prices of ${manifest.prices.asOf}`,
    ]);
  }
  lines.push(...table(facts), "");

  if (summary.evaluators.length === 0) {
    lines.push("no evaluations: the run has no cases or the scenario has no evaluators");
  } else {
    lines.push(
      ...table([
        ["evaluator", "version", "pass", "fail", "n/a", "evaluator error"],
        ...summary.evaluators.map((e) => [
          e.id,
          e.version,
          share(passRate(summary, e.id)),
          String(e.fail.length),
          String(e.notApplicable.length),
          String(e.error.length),
        ]),
      ]),
    );
  }

  if (summary.byTag.length > 0) {
    lines.push(
      "",
      ...table([
        ["tag", "cases", "completed", ...summary.evaluators.map((e) => `${e.id} pass`)],
        ...summary.byTag.map((tag) => [
          tag.tag,
          String(tag.cases),
          `${tag.byStatus.completed.length}/${tag.cases}`,
          ...summary.evaluators.map((e) => share(passRate(tag, e.id))),
        ]),
      ]),
    );
  }

  for (const breakdown of summary.labels) lines.push("", ...renderLabels(breakdown));

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
    `${scenario.id} ${versioned(scenario.version)} · dataset ${dataset.name} · ${cases.length} cases`,
    "",
    ...table(runs.map((run, i) => ["AB"[i]!, `${run.candidate.id} ${versioned(run.candidate.version)}`, `run ${run.runId}`])),
    "",
  ];
  const origins = [a, b].flatMap((run, i) => (run.manifest.origin ? [`${"AB"[i]}: ${imported(run.manifest.origin)}`] : []));
  if (origins.length > 0) lines.push(...origins.map((origin) => `note: ${origin}`), "");
  const traced = [a, b].map((run) => !untraced(run));

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
      row(`${id} pass`, (s) => share(passRate(s, id))),
    ),
    row("median duration", (s) => (s.durationMs ? ms(s.durationMs.median) : "-")),
    row("max duration", (s) => (s.durationMs ? ms(s.durationMs.max) : "-")),
    ["tool calls", ...runs.map((run, i) => (traced[i] ? `${run.summary.toolCalls.total} (${run.summary.toolCalls.failed} failed)` : "not imported"))],
  ];
  if (runs.some((run) => run.summary.modelCalls > 0)) rows.push(row("model calls", (s) => String(s.modelCalls)));
  if (runs.some((run) => run.summary.tokens)) {
    rows.push(row("tokens", (s) => (s.tokens ? `${s.tokens.input} in, ${s.tokens.output} out` : "none reported")));
  }
  if (runs.some((run) => run.summary.cost)) {
    rows.push(
      row("cost", (s) => (s.cost ? `${usd(s.cost.total)}${unpriced(s)}` : "-")),
      row("cost per case (median)", (s) => (s.cost ? usd(s.cost.medianPerCase) : "-")),
    );
  }
  lines.push(...table(rows), "");

  const tagsB = new Map(comparison.b.summary.byTag.map((tag) => [tag.tag, tag]));
  if (comparison.a.summary.byTag.length > 0) {
    const pair = (a: string, b: string) => (a === "n/a" && b === "n/a" ? "n/a" : `${a} · ${b}`);
    lines.push(
      ...table([
        ["tag", "cases", "completed A · B", ...comparison.evaluators.map((e) => `${e.id} pass A · B`)],
        ...comparison.a.summary.byTag.map((tagA) => {
          const tagB = tagsB.get(tagA.tag)!;
          return [
            tagA.tag,
            String(tagA.cases),
            pair(`${tagA.byStatus.completed.length}/${tagA.cases}`, `${tagB.byStatus.completed.length}/${tagB.cases}`),
            ...comparison.evaluators.map((e) => pair(share(passRate(tagA, e.id)), share(passRate(tagB, e.id)))),
          ];
        }),
      ]),
      "",
    );
  }

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
  // A different status or verdict is a difference in how well the sides did. Different wording
  // or a different number of lookups with the same verdicts is listed, but not spelled out.
  const differing = cases.filter(differsInResult);
  const minor = cases.filter((c) => c.differences.length > 0 && !differsInResult(c));
  if (differing.length === 0 && minor.length === 0) {
    lines.push("", "no case differs in status, output, verdicts or tool calls");
  } else if (differing.length === 0) {
    lines.push("", "no case differs in status or verdicts");
  } else {
    const sides = differing.flatMap((c) => [
      [c.caseId, "A", describeSide(resultsA!.get(c.caseId)!, c.a, traced[0]!)],
      ["", "B", describeSide(resultsB!.get(c.caseId)!, c.b, traced[1]!)],
    ]);
    lines.push(
      "",
      `cases that differ in status or verdicts (${differing.length} of ${cases.length})`,
      ...indent(table(sides)),
    );
  }
  if (minor.length > 0) {
    lines.push(
      "",
      `same verdicts, different output or tool calls (${minor.length})`,
      `  ${minor.map((c) => c.caseId).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** A pass count out of the cases the evaluator applies to. */
/** Says what the lab did and did not see of answers it imported. */
export function imported(origin: NonNullable<Manifest["origin"]>): string {
  return `these answers were imported from ${origin.source}, not run by the lab: it measured no durations, and knows only what was imported with them`;
}

/** An imported run that did not say which tools the system had: its tool calls are unknown, not zero. */
export function untraced(run: Pick<RunData, "manifest">): boolean {
  return run.manifest.origin !== undefined && run.manifest.origin.tools === undefined;
}

/** "v1" for a numbered version, the name itself for a named one. */
export function versioned(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/** Which labels were given for which, so that the shape of the mistakes shows and not only their number. */
export function renderLabels(breakdown: LabelBreakdown): string[] {
  const of = (part: string[], whole: string[], ratio: number | null) =>
    ratio === null ? "n/a" : `${part.length}/${whole.length} (${Math.round(ratio * 100)}%)`;
  const lines = [
    `labels given by ${breakdown.evaluator.id}, over the ${breakdown.cases} cases it sorted`,
    ...indent(
      table([
        ["label", "should have", "given", "right", "precision", "recall"],
        ...breakdown.labels.map((l) => [
          l.label,
          String(l.expected.length),
          String(l.given.length),
          String(l.right.length),
          of(l.right, l.given, l.precision),
          of(l.right, l.expected, l.recall),
        ]),
      ]),
    ),
  ];
  if (breakdown.mistakes.length > 0) {
    lines.push(
      "",
      "mistaken for (the label it should have had → the label it was given)",
      ...indent(table(breakdown.mistakes.map((m) => [`${m.expected} → ${m.actual}`, String(m.caseIds.length)]))),
    );
  }
  return lines;
}

/** "7/9", or "7/7 + 2 without an answer" when some cases had none, so a missing answer is never read as a judged one. */
export function share({ pass, of, unanswered = 0 }: { pass: number; of: number; unanswered?: number }): string {
  const parts = [...(of > 0 ? [`${pass}/${of}`] : []), ...(unanswered > 0 ? [`${unanswered} without an answer`] : [])];
  return parts.length === 0 ? "n/a" : parts.join(" + ");
}

export function differsInResult(c: CaseComparison): boolean {
  return c.differences.includes("status") || c.differences.includes("verdicts");
}

function describeSide(result: CaseResult, side: CaseSide, traced: boolean): string {
  if (result.status !== "completed") return describeFailure(result)[1]!;
  const parts = [result.output.kind === "answer" ? `answer ${shorten(JSON.stringify(result.output.value))}` : "abstain"];
  // An imported answer that came without its trace has an unknown number of tool calls, not zero.
  if (traced) parts.push(`${side.toolCalls} tool call${side.toolCalls === 1 ? "" : "s"}`);
  if (side.fallback) parts.push("fallback");
  const withOutcome = (outcome: string) =>
    Object.entries(side.verdicts)
      .filter(([, o]) => o === outcome)
      .map(([id]) => id);
  if (withOutcome("fail").length > 0) parts.push(`fails ${listed(withOutcome("fail"))}`);
  if (withOutcome("error").length > 0) parts.push(`evaluator error in ${listed(withOutcome("error"))}`);
  return parts.join(", ");
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
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
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${value < 10 ? value.toFixed(2) : value.toFixed(0)} ms`;
}

/** Small amounts keep four decimals, since one case often costs a fraction of a cent. */
export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** Says so when some model calls are missing from a cost. */
export function unpriced(summary: SliceSummary): string {
  const count = summary.cost?.unpricedModelCalls ?? 0;
  return count === 0 ? "" : `, ${count} model call${count === 1 ? "" : "s"} not priced`;
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

// --- Overview --------------------------------------------------------------------

/** "86.8–89.0%", "100%", or "n/a" for a check that judged nothing. */
export function range({ low, high }: Pick<Spread, "low" | "high">): string {
  if (low === null || high === null) return "n/a";
  const percent = (share: number) => (share === 0 || share === 1 ? String(share * 100) : (share * 100).toFixed(1));
  return low === high ? `${percent(low)}%` : `${percent(low)}–${percent(high)}%`;
}

/** Every system that ran on one dataset, each check as a range over its runs, and what can be said about the differences. */
export function renderOverview(o: Overview): string {
  const marked = (spread: Spread | undefined) => (spread ? `${range(spread)}${spread.unanswered ? " *" : ""}` : "n/a");
  const systemsTable = (rows: (system: Overview["systems"][number]) => Record<string, Spread> | undefined) =>
    table([
      ["system", "runs", ...o.checks],
      ...o.systems.map((s) => [s.name, String(s.runIds.length), ...o.checks.map((check) => marked(rows(s)?.[check]))]),
    ]);
  const anyUnanswered = o.systems.some((s) => !s.answered);

  const lines = [
    `${o.scenario.id} ${versioned(o.scenario.version)} · dataset ${o.dataset.name} · ${o.dataset.caseCount} cases`,
    "",
    "each check: the share of judged answers that passed, from the lowest to the highest run",
    "",
    ...systemsTable((s) => s.checks),
  ];
  if (anyUnanswered) lines.push("* a run of this system has cases without an answer");

  for (const { tag, cases } of o.tags) {
    lines.push("", `tag ${tag} (${cases} cases)`, ...indent(systemsTable((s) => s.byTag[tag])));
  }

  lines.push("", "differences", ...indent(differences(o)));

  lines.push("", "runs and how steady they were");
  for (const s of o.systems) {
    lines.push(`  ${s.name}, ${s.runIds.length} run${s.runIds.length === 1 ? "" : "s"}`);
    lines.push(
      ...indent(
        indent(table(s.runIds.map((runId, i) => [runId, ...o.checks.map((check) => `${check} ${share(s.checks[check]!.runs[i]!)}`)]))),
      ),
    );
    if (!s.steadiness) continue;
    for (const check of o.checks) lines.push(...steadyLines(check, s.steadiness[check]!).map((line, i) => `${i === 0 ? "    " : "      "}${line}`));
  }

  if (o.leftOut.length > 0) {
    lines.push("", "left out", ...indent(table(o.leftOut.map(({ runId, reason }) => [runId, reason]))));
  }
  return lines.join("\n");
}

/** How steady one check was over a system's runs, as a line and the cases behind it. */
export function steadyLines(check: string, steady: Steadiness): string[] {
  const same = steady.passedEveryTime.length + steady.failedEveryTime.length;
  const lines = [
    steady.varied.length === 0 && steady.unanswered.length === 0
      ? `${check}: the same verdict in every run`
      : `${check}: the same verdict in every run on ${same} cases (${steady.passedEveryTime.length} passed every time, ${steady.failedEveryTime.length} failed every time)`,
  ];
  if (steady.varied.length > 0) {
    lines.push(`varied on ${steady.varied.length}: ${steady.varied.map((v) => `${v.caseId} passed ${v.passed} of ${v.of}`).join(", ")}`);
  }
  if (steady.unanswered.length > 0) {
    lines.push(`without an answer in some run: ${steady.unanswered.join(", ")}`);
  }
  return lines;
}

/** What can be said about the differences between systems, in sentences. */
export function differences(o: Overview): string[] {
  const rule = `a difference is called only between systems with at least ${MIN_RUNS} runs each, every case answered in every run, whose ranges do not overlap`;
  if (o.eligible.length < 2) {
    const qualifying = o.eligible.length === 0 ? "no system qualifies" : `only ${o.eligible[0]} qualifies`;
    return [`none can be called yet: ${rule}, and ${qualifying}`];
  }
  const lines = o.differences.map(({ check, higher, lower }) => {
    const spread = (name: string) => range(o.systems.find((s) => s.name === name)!.checks[check]!);
    return `${higher} is higher than ${lower} on ${check}: ${spread(higher)} against ${spread(lower)}`;
  });
  if (o.overlaps.length > 0) {
    lines.push(...o.overlaps.map(({ a, b, check }) => `${a} and ${b} overlap on ${check}, so no difference is called`));
  }
  lines.push(...o.incomparable.map(({ a, b, reasons }) => `${a} and ${b} cannot be compared: ${reasons.join("; ")}`));
  return lines;
}
