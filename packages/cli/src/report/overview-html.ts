/**
 * The overview as one self-contained page: every system that ran on one
 * dataset, each check as a range over its runs, and what can be said about the
 * differences. Formatting only; the numbers come from core.
 */
import type { Overview, Spread } from "@agent-quality-lab/core";
import { differences, range, share, steadyLines, versioned } from "../render.ts";
import { asset, html, type Markup } from "./markup.ts";

export function renderOverviewHtml(o: Overview): string {
  const anyUnanswered = o.systems.some((s) => !s.answered);
  const page = html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.scenario.id}: overview of ${o.dataset.name}</title>
<style>${asset(new URL("./report.css", import.meta.url))}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Agent Quality Lab · overview of every system on one dataset</p>
  <h1>${o.scenario.id} <small>${versioned(o.scenario.version)}</small></h1>
  <p class="sub">dataset ${o.dataset.name} (${o.dataset.sha256.slice(0, 8)}) · ${o.dataset.caseCount} cases · ${o.systems.length} systems</p>
</header>
<section>
  <h2>Each check, over each system's runs</h2>
  <p class="sub">The share of judged answers that passed, from the lowest run to the highest.</p>
  ${systemsTable(o, (s) => s.checks)}
  ${anyUnanswered && html`<p class="hint">* A run of this system has cases without an answer.</p>`}
</section>
${o.tags.map(
  ({ tag, cases }) => html`<section>
  <h2>Tag ${tag} <small>${cases} cases</small></h2>
  ${systemsTable(o, (s) => s.byTag[tag])}
</section>`,
)}
<section>
  <h2>Differences</h2>
  <ul>${differences(o).map((line) => html`<li>${sentence(line)}</li>`)}</ul>
</section>
<section>
  <h2>Runs, and how steady they were</h2>
  ${o.systems.map(
    (s) => html`<details class="fold" ${s.steadiness && html`open`}><summary>${s.name}, ${s.runIds.length} run${s.runIds.length === 1 ? "" : "s"}</summary>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Run</th>${o.checks.map((check) => html`<th scope="col">${check}</th>`)}</tr></thead>
      <tbody>${s.runIds.map(
        (runId, i) => html`<tr><td><code>${runId}</code></td>${o.checks.map((check) => html`<td>${share(s.checks[check]!.runs[i]!)}</td>`)}</tr>`,
      )}</tbody>
    </table></div>
    ${s.steadiness && html`<ul>${o.checks.map((check) => html`<li>${steadyLines(check, s.steadiness![check]!).map(sentence).join(" ")}</li>`)}</ul>`}
  </details>`,
  )}
</section>
${
  o.leftOut.length > 0 &&
  html`<section>
  <h2>Left out</h2>
  <ul>${o.leftOut.map(({ runId, reason }) => html`<li><code>${runId}</code>: ${reason}</li>`)}</ul>
</section>`
}
</main>
</body>
</html>`;
  return `<!doctype html>\n${page.text}\n`;
}

function systemsTable(o: Overview, rows: (system: Overview["systems"][number]) => Record<string, Spread> | undefined): Markup {
  return html`<div class="table-wrap"><table>
    <thead><tr><th scope="col">System</th><th scope="col">Runs</th>${o.checks.map((check) => html`<th scope="col">${check}</th>`)}</tr></thead>
    <tbody>${o.systems.map(
      (s) => html`<tr><th scope="row">${s.name}</th><td>${s.runIds.length}</td>${o.checks.map((check) => {
        const spread = rows(s)?.[check];
        return html`<td>${spread ? range(spread) : "n/a"}${spread?.unanswered && " *"}</td>`;
      })}</tr>`,
    )}</tbody>
  </table></div>`;
}

const sentence = (line: string) => `${line[0]!.toUpperCase()}${line.slice(1)}.`;
