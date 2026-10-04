/**
 * Renders a comparison as one self-contained HTML page: no server, no build
 * step, nothing loaded from elsewhere. The page is complete as static markup;
 * report.js only adds filtering.
 *
 * Everything a candidate produced is untrusted text. The `html` tag below
 * escapes every interpolated value, so markup can only come from this file.
 */
import { readFileSync } from "node:fs";
import type {
  CaseComparison,
  CaseResult,
  CaseSide,
  Comparison,
  DatasetCase,
  EvaluationRecord,
  Manifest,
  RunData,
  RunSummary,
  TraceEvent,
  Verdict,
} from "@agent-quality-lab/core";
import { ms } from "../render.ts";

export interface HtmlReport {
  comparison: Comparison;
  a: RunData;
  b: RunData;
  /** The cases both runs used, for showing each case's input and expected behaviour. */
  cases: readonly DatasetCase[];
}

/** Markup that is safe to insert as it is. Anything else interpolated into `html` is escaped. */
class Markup {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function html(strings: TemplateStringsArray, ...values: unknown[]): Markup {
  return new Markup(strings.reduce((out, part, i) => out + insert(values[i - 1]) + part));
}

function insert(value: unknown): string {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(insert).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const asset = (name: string) => new Markup(readFileSync(new URL(name, import.meta.url), "utf8"));
const json = (value: unknown) => JSON.stringify(value, null, 2);
const shorten = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

export function renderHtmlReport({ comparison, a, b, cases }: HtmlReport): string {
  const { scenario, dataset } = comparison;
  const runs = [
    { label: "A", run: comparison.a, data: a },
    { label: "B", run: comparison.b, data: b },
  ];
  const sampled = [...new Set(runs.filter(({ run }) => !run.candidate.deterministic).map(({ run }) => run.candidate.id))];

  const page = html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${scenario.id}: ${comparison.a.candidate.id} and ${comparison.b.candidate.id}</title>
<style>${asset("./report.css")}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Agent Quality Lab · comparison of two runs</p>
  <h1>${scenario.id} <small>v${scenario.version}</small></h1>
  <p class="sub">dataset ${dataset.name} (${dataset.sha256.slice(0, 8)}) · ${comparison.cases.length} cases · time limit ${ms(a.manifest.settings.timeoutMs)} per case</p>
  <div class="runs">${runs.map(({ label, data }) => runCard(label, data.manifest))}</div>
  ${
    sampled.length > 0 &&
    html`<p class="note">Not deterministic: ${sampled.join(", ")}. Each run is one sample, so a difference on a single case may be noise.</p>`
  }
</header>
${summarySection(comparison)}
${casesSection(comparison, a, b, cases)}
</main>
<script>${asset("./report.js")}</script>
</body>
</html>`;
  return `<!doctype html>\n${page.text}\n`;
}

function runCard(label: string, manifest: Manifest): Markup {
  const { candidate, environment } = manifest;
  const git = environment.git
    ? `${environment.git.commit.slice(0, 7)}${environment.git.dirty ? ", with uncommitted changes" : ""}`
    : "not recorded";
  return html`<div class="card">
    <h2><span class="side">${label}</span>${candidate.id} <small>v${candidate.version}</small></h2>
    <dl>
      <dt>Run</dt><dd><code>${manifest.runId}</code></dd>
      <dt>Started</dt><dd>${manifest.startedAt}</dd>
      <dt>Deterministic</dt><dd>${candidate.deterministic ? "yes" : "no"}</dd>
      <dt>Config</dt><dd><code>${JSON.stringify(candidate.config)}</code></dd>
      <dt>Lab commit</dt><dd>${git}</dd>
      <dt>Runtime</dt><dd>Node ${environment.node} on ${environment.platform}</dd>
    </dl>
  </div>`;
}

// --- Summary -------------------------------------------------------------------

/** A number that filters the case list to the cases behind it. */
function count(caseIds: readonly string[], label: string, text: string = String(caseIds.length)): Markup {
  if (caseIds.length === 0) return html`<span class="zero">${text}</span>`;
  return html`<button class="count" data-cases="${JSON.stringify(caseIds)}" data-label="${label}" aria-label="${label}: ${text}. Show these cases" title="Show these cases">${text}</button>`;
}

function summarySection(comparison: Comparison): Markup {
  const sides: [string, RunSummary][] = [
    ["A", comparison.a.summary],
    ["B", comparison.b.summary],
  ];
  const row = (label: string, cell: (summary: RunSummary, side: string) => unknown) =>
    html`<tr><th scope="row">${label}</th>${sides.map(([side, summary]) => html`<td>${cell(summary, side)}</td>`)}</tr>`;
  const total = comparison.cases.length;

  return html`<section>
  <h2>Execution</h2>
  <div class="table-wrap"><table>
    <thead><tr><th></th><th scope="col">A</th><th scope="col">B</th></tr></thead>
    <tbody>
      ${row("Completed", (s, side) => count(s.byStatus.completed, `${side}: completed`, `${s.byStatus.completed.length}/${total}`))}
      ${row("Malformed output", (s, side) => count(s.byStatus.malformed_output, `${side}: malformed output`))}
      ${row("Error", (s, side) => count(s.byStatus.error, `${side}: error`))}
      ${row("Timeout", (s, side) => count(s.byStatus.timeout, `${side}: timeout`))}
      ${row("Fallbacks", (s, side) => count(s.fallbacks, `${side}: fallback`))}
      ${row("Median duration", (s) => (s.durationMs ? ms(s.durationMs.median) : "–"))}
      ${row("Max duration", (s) => (s.durationMs ? ms(s.durationMs.max) : "–"))}
      ${row("Tool calls", (s) => `${s.toolCalls.total} (${s.toolCalls.failed} failed)`)}
      ${row("Tokens", (s) => (s.tokens ? `${s.tokens.input} in, ${s.tokens.output} out` : "none reported"))}
    </tbody>
  </table></div>
</section>
<section>
  <h2>Evaluators</h2>
  ${
    comparison.evaluators.length === 0
      ? html`<p class="sub">No evaluations: the runs have no cases or the scenario has no evaluators.</p>`
      : html`<div class="table-wrap"><table class="grouped">
    <thead><tr>
      <th scope="col">Evaluator</th><th scope="col">Run</th><th scope="col">Pass</th><th scope="col">Fail</th>
      <th scope="col">Not evaluated</th><th scope="col">Not applicable</th><th scope="col">Evaluator error</th>
      <th scope="col">Passes on one side only</th>
    </tr></thead>
    <tbody>${comparison.evaluators.map((evaluator) => {
      const oneSided = html`${count(evaluator.onlyA, `${evaluator.id}: passes only in A`)} only in A,
        ${count(evaluator.onlyB, `${evaluator.id}: passes only in B`)} only in B${
          evaluator.undetermined.length > 0 &&
          html`, ${count(evaluator.undetermined, `${evaluator.id}: cannot be compared`)} cannot be compared`
        }`;
      return sides.map(([side, summary], i) => {
        const e = summary.evaluators.find((candidate) => candidate.id === evaluator.id)!;
        const name = `${evaluator.id}, ${side}`;
        return html`<tr class="${i === sides.length - 1 && "group-end"}">
        ${i === 0 && html`<th scope="rowgroup" rowspan="${sides.length}">${evaluator.id} <small>v${evaluator.version}</small></th>`}
        <td><span class="side">${side}</span></td>
        <td>${meter(e.pass.length, total)}${count(e.pass, `${name}: pass`, `${e.pass.length}/${total}`)}</td>
        <td>${count(e.fail, `${name}: fail`)}</td>
        <td>${count(e.notEvaluated, `${name}: not evaluated`)}</td>
        <td>${count(e.notApplicable, `${name}: not applicable`)}</td>
        <td>${count(e.error, `${name}: evaluator error`)}</td>
        ${i === 0 && html`<td class="wide" rowspan="${sides.length}">${oneSided}</td>`}
      </tr>`;
      });
    })}</tbody>
  </table></div>`
  }
</section>`;
}

function meter(part: number, whole: number): Markup {
  const width = whole === 0 ? 0 : (part / whole) * 100;
  return html`<span class="meter" role="img" aria-label="${part} of ${whole} cases pass" title="${part} of ${whole} cases pass"><span style="width:${width.toFixed(1)}%"></span></span>`;
}

// --- Cases ---------------------------------------------------------------------

function casesSection(comparison: Comparison, a: RunData, b: RunData, cases: readonly DatasetCase[]): Markup {
  const ids = comparison.cases.map((c) => c.caseId);
  const differing = comparison.cases.filter((c) => c.differences.length > 0).map((c) => c.caseId);
  const incomplete = comparison.cases
    .filter((c) => c.a.status !== "completed" || c.b.status !== "completed")
    .map((c) => c.caseId);
  const filter = (label: string, caseIds: string[], pressed = false) =>
    html`<button class="filter" data-cases="${JSON.stringify(caseIds)}" data-label="${label}" aria-pressed="${String(pressed)}">${label} ${caseIds.length}</button>`;

  const inputs = new Map(cases.map((c) => [c.id, c]));
  const details = [a, b].map((run) => ({
    results: new Map(run.results.map((result) => [result.caseId, result])),
    evaluations: Map.groupBy(run.evaluations ?? [], (record) => record.caseId),
  }));

  return html`<section id="cases">
  <h2>Cases</h2>
  <div class="filters">
    ${filter("All", ids, true)}
    ${filter("Differ", differing)}
    ${filter("Not completed on a side", incomplete)}
    <button class="filter" id="toggle-all" aria-pressed="false" hidden>Expand all</button>
    <span id="filter-status" role="status">All: ${ids.length} of ${ids.length} cases</span>
  </div>
  <div class="case-list">${comparison.cases.map((c) => {
    const sides = [c.a, c.b].map((side, i) => ({
      label: "AB"[i]!,
      side,
      result: details[i]!.results.get(c.caseId)!,
      evaluations: details[i]!.evaluations.get(c.caseId) ?? [],
    }));
    return caseEntry(c, inputs.get(c.caseId), sides);
  })}</div>
</section>`;
}

interface SideView {
  label: string;
  side: CaseSide;
  result: CaseResult;
  evaluations: readonly EvaluationRecord[];
}

const DIFFERENCE = { status: "status", output: "output", verdicts: "verdicts", tool_calls: "tool calls" } as const;

function caseEntry(c: CaseComparison, input: DatasetCase | undefined, sides: SideView[]): Markup {
  return html`<details class="case" data-case="${c.caseId}">
    <summary>
      <span class="case-id">${c.caseId}${
        c.differences.length > 0 &&
        html`<span class="differs">differs in ${c.differences.map((d) => DIFFERENCE[d]).join(", ")}</span>`
      }</span>
      ${sides.map((view) => html`<span class="brief"><span class="side">${view.label}</span><span class="brief-items">${brief(view)}</span></span>`)}
    </summary>
    <div class="case-body">
      <div class="case-io">
        <div><p class="label">Input</p><pre>${json(input?.input)}</pre></div>
        <div><p class="label">Expected</p>${
          input?.expected === undefined ? html`<p class="empty">none</p>` : html`<pre>${json(input.expected)}</pre>`
        }</div>
        ${
          input?.setup !== undefined &&
          html`<div><p class="label">Setup, hidden from the candidate</p><pre>${json(input.setup)}</pre></div>`
        }
      </div>
      <div class="columns">${sides.map(sideDetail)}</div>
    </div>
  </details>`;
}

const STATUS = { completed: "completed", malformed_output: "malformed output", error: "error", timeout: "timeout" } as const;

/** How to show each verdict: a glyph class, and the word for it. */
const OUTCOME: Record<Verdict["outcome"], [string, string]> = {
  pass: ["pass", "pass"],
  fail: ["fail", "fail"],
  not_evaluated: ["incomplete", "not evaluated"],
  not_applicable: ["neutral", "not applicable"],
  error: ["caution", "evaluator error"],
};

/** One line per side in the collapsed case: what it returned and how it was judged. */
function brief({ side, result, evaluations }: SideView): Markup {
  if (result.status !== "completed") {
    return html`<span class="chip incomplete">${STATUS[result.status]}</span>`;
  }
  const output =
    result.output.kind === "answer"
      ? html`<code>${shorten(JSON.stringify(result.output.value))}</code>`
      : html`<span>abstained</span>`;
  return html`${output}${evaluations.map(
    ({ evaluator, verdict }) =>
      html`<span class="chip ${OUTCOME[verdict.outcome][0]}" title="${evaluator.id}: ${OUTCOME[verdict.outcome][1]}">${evaluator.id}</span>`,
  )}${side.fallback && html`<span class="chip caution">fallback</span>`}`;
}

function sideDetail({ label, side, result, evaluations }: SideView): Markup {
  return html`<div class="column">
    <h3><span class="side">${label}</span>${STATUS[result.status]} <small>in ${ms(side.durationMs)}</small></h3>
    ${outcomeBlock(result)}
    <div class="block">
      <p class="label">Verdicts</p>
      <ul class="verdicts">${evaluations.map(
        ({ evaluator, verdict }) =>
          html`<li class="${OUTCOME[verdict.outcome][0]}">${evaluator.id}: ${OUTCOME[verdict.outcome][1]}${
            "value" in verdict && verdict.value !== undefined && html` <span class="detail">(value ${verdict.value})</span>`
          }${verdict.detail !== undefined && html` <span class="detail">· ${verdict.detail}</span>`}</li>`,
      )}</ul>
    </div>
    <div class="block">
      <p class="label">Trace</p>
      ${
        result.trace.length === 0
          ? html`<p class="empty">nothing observed or reported</p>`
          : html`<ol class="trace">${result.trace.map(traceEvent)}</ol>`
      }
    </div>
  </div>`;
}

function outcomeBlock(result: CaseResult): Markup {
  switch (result.status) {
    case "completed":
      return result.output.kind === "answer"
        ? html`<div class="block"><p class="label">Answer</p><pre>${json(result.output.value)}</pre></div>`
        : html`<div class="block"><p class="label">Abstained</p><p>${result.output.reason}</p></div>`;
    case "malformed_output":
      return html`<div class="block"><p class="label">Problem</p><p>${result.problem}</p></div>
        ${result.rawOutput !== undefined && html`<div class="block"><p class="label">Returned</p><pre>${json(result.rawOutput)}</pre></div>`}`;
    case "error":
      return html`<div class="block"><p class="label">Error</p><pre>${result.error.stack ?? result.error.message}</pre></div>`;
    case "timeout":
      return html`<div class="block"><p class="label">Time limit</p><p>${ms(result.timeoutMs)}</p></div>`;
  }
}

function traceEvent(event: TraceEvent): Markup {
  const took = "durationMs" in event && event.durationMs !== undefined && html` <span class="detail">· ${ms(event.durationMs)}</span>`;
  let body: Markup;
  if (event.type === "tool_call") {
    const outcome =
      event.error !== undefined
        ? html`<span class="chip fail">${event.error}</span>`
        : event.result !== undefined
          ? html`<code>→ ${JSON.stringify(event.result)}</code>`
          : html`<span class="detail">had not returned when the case ended</span>`;
    body = html`<code>${event.name}(${JSON.stringify(event.args)})</code><span class="outcome">${outcome}${took}</span>`;
  } else if (event.type === "model_call") {
    body = html`model call to <code>${event.model}</code>${
      event.usage && html` <span class="detail">· ${event.usage.inputTokens} tokens in, ${event.usage.outputTokens} out</span>`
    }${took}`;
  } else {
    body = html`<span class="chip caution">fallback</span> from <code>${event.from}</code> to <code>${event.to}</code> <span class="detail">· ${event.reason}</span>`;
  }
  return html`<li><span class="source">${event.source}</span><span>${body}</span></li>`;
}
