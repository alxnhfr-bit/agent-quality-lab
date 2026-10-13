/**
 * The pages of the interface, as plain HTML built on the server. There is no
 * script on them: forms post to the lab, and a run in progress reloads itself.
 * Everything a person or a model wrote is escaped by the `html` tag.
 */
import { CLAUDE_MODELS } from "@agent-quality-lab/models/anthropic";
import { usd } from "../render.ts";
import { asset, html, type Markup } from "../report/markup.ts";
import { DEMO_MODEL } from "./demo.ts";
import { MAX_COST, type RunState } from "./runs.ts";
import type { Scorecard, ScoredCase } from "./scorecard.ts";
import { formatQuestions, type Agent, type AgentDraft, type Test } from "./workspace.ts";

/** What every page needs to know about the session it is shown in. */
export interface Chrome {
  /** Sent back with every form, so that only pages the lab served can change anything. */
  token: string;
  demo: boolean;
  keyFound: boolean;
}

export const CRITERION_ROWS = 8;
const DEFAULT_JUDGE = "claude-opus-5-5";
const STEPS = [
  ["/agent", "Agent"],
  ["/test", "Test"],
  ["/results", "Results"],
] as const;

const modelName = (id: string) =>
  id === DEMO_MODEL ? "no model (demo)" : (CLAUDE_MODELS.find((model) => model.id === id)?.name ?? id);
/** A moment as this computer's clock shows it. The lab runs on the reader's own computer. */
function day(iso: string): string {
  const at = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

function layout(chrome: Chrome, step: 1 | 2 | 3, title: string, body: Markup, reloadSeconds?: number): string {
  const page = html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${reloadSeconds !== undefined && html`<meta http-equiv="refresh" content="${reloadSeconds}">`}
<title>${title} · Agent Quality Lab</title>
<style>${asset(new URL("../report/report.css", import.meta.url))}${asset(new URL("./app.css", import.meta.url))}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Agent Quality Lab</p>
  <nav aria-label="Steps">${STEPS.map(
    ([href, label], i) =>
      html`<a href="${href}" ${i + 1 === step && html`aria-current="step"`}><span class="step">${i + 1}</span>${label}</a>`,
  )}</nav>
  ${
    chrome.demo
      ? html`<p class="note">Demo mode. No model is called, so answers and verdicts are placeholders and nothing costs anything.</p>`
      : !chrome.keyFound &&
        html`<p class="note">No API key was found, so tests cannot run yet. Add <code>ANTHROPIC_API_KEY</code> to your terminal settings and start the lab again.</p>`
  }
</header>
${body}
</main>
</body>
</html>`;
  return `<!doctype html>\n${page.text}\n`;
}

const message = (error: string | undefined, saved: string | undefined) =>
  html`${error && html`<p class="error" role="alert">${error}</p>`}${saved && html`<p class="saved" role="status">${saved}</p>`}`;

function modelSelect(name: string, selected: string): Markup {
  return html`<select name="${name}" id="${name}">${CLAUDE_MODELS.map(
    (model) => html`<option value="${model.id}" ${model.id === selected && html`selected`}>${model.name}</option>`,
  )}</select>`;
}

function sideList(label: string, path: string, items: { id: string; name: string; detail: string }[], current?: string): Markup {
  return html`<aside class="card sidebar">
    <p class="label">${label}</p>
    ${items.length === 0 && html`<p class="empty">None yet.</p>`}
    <ul>${items.map(
      (item) =>
        html`<li><a href="${path}?id=${item.id}" ${item.id === current && html`aria-current="true"`}>${item.name}</a><span class="detail">${item.detail}</span></li>`,
    )}</ul>
    <a class="button" href="${path}">New</a>
  </aside>`;
}

// --- Step 1: the agent ---------------------------------------------------------

export function agentPage(
  chrome: Chrome,
  agents: { id: string; agent: Agent }[],
  current: { id: string; agent: Agent } | undefined,
  options: { draft?: AgentDraft | undefined; error?: string | undefined; saved?: string | undefined } = {},
): string {
  const latest = current?.agent.versions.at(-1);
  const draft = options.draft ?? {
    name: current?.agent.name ?? "",
    model: latest?.model ?? CLAUDE_MODELS[0].id,
    instructions: latest?.instructions ?? "",
  };
  const list = agents.map(({ id, agent }) => ({
    id,
    name: agent.name,
    detail: `version ${agent.versions.at(-1)!.version}`,
  }));

  return layout(
    chrome,
    1,
    "Agent",
    html`<section>
  <h1>What are you testing?</h1>
  <p class="sub">An agent here is a set of instructions and a model. Each change to the instructions is saved as a new version, so you can see whether it helped.</p>
  <div class="split">
    ${sideList("Your agents", "/agent", list, current?.id)}
    <form class="card" method="post" action="/agent">
      <input type="hidden" name="token" value="${chrome.token}">
      ${current && html`<input type="hidden" name="id" value="${current.id}">`}
      ${message(options.error, options.saved)}
      <div class="fields">
        <div><label for="name">Name</label><input id="name" name="name" value="${draft.name}" placeholder="Cancellation helper"></div>
        <div><label for="model">Model</label>${modelSelect("model", draft.model)}</div>
      </div>
      <label for="instructions">The agent's instructions</label>
      <textarea id="instructions" name="instructions" rows="12" placeholder="You help travelers with questions about cancelling a booking. Always state the fee and which policy it comes from.">${draft.instructions}</textarea>
      <div class="actions">
        <button class="primary">${current ? "Save as new version" : "Save agent"}</button>
        ${current && html`<a href="/results?agent=${current.id}">Test this agent</a>`}
      </div>
      ${
        current &&
        html`<div class="block"><p class="label">Versions</p><ul class="plain">${current.agent.versions
          .toReversed()
          .map((v) => html`<li>Version ${v.version} · ${modelName(v.model)} · saved ${day(v.savedAt)}</li>`)}</ul></div>`
      }
    </form>
  </div>
</section>`,
  );
}

// --- Step 2: the test ----------------------------------------------------------

export interface TestForm {
  name: string;
  questions: string;
  criteria: { text: string; mustHave: boolean }[];
  judgeModel: string;
}

export function testPage(
  chrome: Chrome,
  tests: { id: string; test: Test }[],
  current: { id: string; test: Test } | undefined,
  options: { draft?: TestForm | undefined; error?: string | undefined; saved?: string | undefined } = {},
): string {
  const draft: TestForm = options.draft ?? {
    name: current?.test.name ?? "",
    questions: current ? formatQuestions(current.test.questions) : "",
    criteria: current?.test.criteria ?? [],
    judgeModel: current?.test.judgeModel ?? DEFAULT_JUDGE,
  };
  const list = tests.map(({ id, test }) => ({
    id,
    name: test.name,
    detail: `${test.questions.length} questions, ${test.criteria.length} criteria`,
  }));
  const rows = Array.from({ length: CRITERION_ROWS }, (_, i) => draft.criteria[i] ?? { text: "", mustHave: true });

  return layout(
    chrome,
    2,
    "Test",
    html`<section>
  <h1>What should it do?</h1>
  <p class="sub">A test is a list of example questions, and a few sentences that describe a good answer. A judge model reads every answer and decides each sentence with yes or no.</p>
  <div class="split">
    ${sideList("Your tests", "/test", list, current?.id)}
    <form class="card" method="post" action="/test">
      <input type="hidden" name="token" value="${chrome.token}">
      ${current && html`<input type="hidden" name="id" value="${current.id}">`}
      ${message(options.error, options.saved)}
      <label for="name">Name</label>
      <input id="name" name="name" value="${draft.name}" placeholder="Cancellation questions">

      <label for="questions">Example questions</label>
      <textarea id="questions" name="questions" rows="8" placeholder="Can I cancel booking BK-1002 for free today? | The fee is 300 EUR">${draft.questions}</textarea>
      <p class="hint">One question per line. If you know the right answer, add a note after <code> | </code>, or paste two columns from a spreadsheet: the question, then the note.</p>

      <p class="field-label">A good answer</p>
      <p class="hint">One sentence per row, written so that it can be answered with yes or no. An answer counts as good when it meets every must-have.</p>
      <div class="criteria">${rows.map(
        (row, i) =>
          html`<div class="criterion">
            <input name="criterion-${i}" value="${row.text}" aria-label="Criterion ${i + 1}" placeholder="${i === 0 && "States the fee as an amount"}">
            <label class="check"><input type="checkbox" name="must-${i}" ${row.mustHave && html`checked`}> Must have</label>
          </div>`,
      )}</div>

      <label for="judgeModel">Judge</label>
      ${modelSelect("judgeModel", draft.judgeModel)}
      <p class="hint">The model that reads the answers. A more capable judge makes fewer wrong calls and costs a little more.</p>

      <div class="actions">
        <button class="primary">Save test</button>
        ${current && html`<a href="/results?test=${current.id}">Run this test</a>`}
      </div>
    </form>
  </div>
</section>`,
  );
}

// --- Step 3: results -----------------------------------------------------------

export interface PastRun {
  runId: string;
  state: RunState;
  scorecard?: Scorecard | undefined;
}

export function resultsPage(
  chrome: Chrome,
  agents: { id: string; agent: Agent }[],
  tests: { id: string; test: Test }[],
  past: PastRun[],
  options: { agent?: string | undefined; test?: string | undefined; error?: string | undefined } = {},
): string {
  const ready = agents.length > 0 && tests.length > 0;
  return layout(
    chrome,
    3,
    "Results",
    html`<section>
  <h1>How did it do?</h1>
  <p class="sub">Run a test against one version of an agent. The agent answers every question, then the judge reads every answer.</p>
  ${
    !ready
      ? html`<p class="card">${agents.length === 0 ? html`<a href="/agent">Describe an agent</a> first. ` : ""}${tests.length === 0 ? html`<a href="/test">Describe a test</a> first.` : ""}</p>`
      : html`<form class="card" method="post" action="/runs">
    <input type="hidden" name="token" value="${chrome.token}">
    ${message(options.error, undefined)}
    <div class="fields">
      <div><label for="agent">Agent</label><select id="agent" name="agent">${agents.flatMap(({ id, agent }) =>
        agent.versions
          .toReversed()
          .map(
            (v) =>
              html`<option value="${id}:${v.version}" ${id === options.agent && v === agent.versions.at(-1) && html`selected`}>${agent.name}, version ${v.version} (${modelName(v.model)})</option>`,
          ),
      )}</select></div>
      <div><label for="test">Test</label><select id="test" name="test">${tests.map(
        ({ id, test }) =>
          html`<option value="${id}" ${id === options.test && html`selected`}>${test.name} (${test.questions.length} questions)</option>`,
      )}</select></div>
    </div>
    <div class="actions">
      <button class="primary" ${!chrome.demo && !chrome.keyFound && html`disabled`}>Run test</button>
      <span class="hint">${
        chrome.demo
          ? "Demo mode: nothing is called and nothing is charged."
          : `This calls the agent's model once per question and the judge once per answer. It stops if the answers cost more than ${usd(MAX_COST)}.`
      }</span>
    </div>
  </form>`
  }
</section>
${
  past.length > 0 &&
  html`<section>
  <h2>Earlier runs</h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">When</th><th scope="col">Agent</th><th scope="col">Test</th><th scope="col">Good answers</th></tr></thead>
    <tbody>${past.map(({ runId, state, scorecard }) =>
      scorecard
        ? html`<tr><td>${day(scorecard.startedAt)}</td><td>${scorecard.agent.name}, version ${scorecard.agent.version}</td><td>${scorecard.test.name}</td><td><a href="/runs/${runId}">${scorecard.good} of ${scorecard.total}</a>${scorecard.demo && " (demo)"}</td></tr>`
        : html`<tr><td colspan="3"><code>${runId}</code></td><td><a href="/runs/${runId}">${state.phase === "done" ? "open" : state.phase}</a></td></tr>`,
    )}</tbody>
  </table></div>
</section>`
}`,
  );
}

export function runPage(chrome: Chrome, runId: string, state: RunState, scorecard?: Scorecard): string {
  if (state.phase === "answering" || state.phase === "judging") {
    const doing = state.phase === "answering" ? "The agent is answering" : "The judge is reading the answers";
    return layout(
      chrome,
      3,
      "Running",
      html`<section class="card" role="status">
  <h1>${doing}…</h1>
  <p class="sub">${state.done} of ${state.total} done. This page updates by itself.</p>
  <span class="meter wide"><span style="width:${((state.done / Math.max(1, state.total)) * 100).toFixed(0)}%"></span></span>
</section>`,
      2,
    );
  }
  if (state.phase !== "done" || !scorecard) {
    // The engine calls whatever it runs a candidate; here that is always the agent.
    const reason = "reason" in state ? state.reason.replace(/^the candidate\b/, "the agent") : "its results could not be read";
    return layout(
      chrome,
      3,
      "Run stopped",
      html`<section class="card">
  <h1>This run did not finish</h1>
  <p class="sub">It stopped because ${reason}.</p>
  <p><a class="button" href="/results">Back to results</a></p>
  <p class="hint">Run <code>${runId}</code></p>
</section>`,
    );
  }
  return layout(chrome, 3, "Scorecard", scorecardBody(scorecard));
}

function scorecardBody(card: Scorecard): Markup {
  const notGood = card.cases.filter((c) => c.rating === "not good");
  const notJudged = card.cases.filter((c) => c.rating === "not judged");
  const good = card.cases.filter((c) => c.rating === "good");
  const cost =
    card.agentCost === null || card.judgeCost === null
      ? "not known"
      : usd(card.agentCost + card.judgeCost);

  return html`<section>
  <p class="eyebrow">${card.test.name} · ${day(card.startedAt)}</p>
  <h1>${card.agent.name} <small>version ${card.agent.version} · ${modelName(card.agent.model)}</small></h1>
  ${card.demo && html`<p class="note">This was a demo run. No model was called, so the answers and verdicts below are placeholders.</p>`}
  <div class="metrics">
    <div class="metric"><p class="label">Good answers</p><p class="figure">${card.good} of ${card.total}</p>${
      card.notJudged > 0 && html`<p class="hint">${card.notJudged} could not be judged</p>`
    }</div>
    <div class="metric"><p class="label">Cost of this run</p><p class="figure">${cost}</p>${
      card.agentCost !== null &&
      card.judgeCost !== null &&
      html`<p class="hint">${usd(card.agentCost)} for the answers, ${usd(card.judgeCost)} for judging</p>`
    }</div>
    <div class="metric"><p class="label">Time per answer</p><p class="figure">${card.medianSeconds === null ? "not known" : `${card.medianSeconds} s`}</p></div>
  </div>
  <p class="hint">An answer is good when it meets every must-have. ${
    card.test.judgedBy.length === 0 ? "No answer was read by a judge." : `Judged by ${card.test.judgedBy.map(modelName).join(" and ")}.`
  }</p>
</section>
<section>
  <h2>By criterion</h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">A good answer</th><th scope="col"></th><th scope="col">Met</th></tr></thead>
    <tbody>${card.criteria.map(
      (criterion) =>
        html`<tr><td class="wide">${criterion.text}</td><td>${criterion.mustHave ? "Must have" : "Nice to have"}</td><td><span class="meter"><span style="width:${((criterion.met / Math.max(1, criterion.judged)) * 100).toFixed(0)}%"></span></span>${criterion.met} of ${criterion.judged}</td></tr>`,
    )}</tbody>
  </table></div>
</section>
${
  notJudged.length > 0 &&
  html`<section>
  <h2>Answers that could not be judged (${notJudged.length})</h2>
  <p class="sub">The judge failed on these, so they count as neither good nor not good. Running the test again usually clears it.</p>
  <div class="answers">${notJudged.map((c) => answerCard(c, true))}</div>
</section>`
}
<section>
  <h2>${notGood.length > 0 ? `Answers that were not good (${notGood.length})` : notJudged.length > 0 ? "No answer was found not good" : "Every answer was good"}</h2>
  <div class="answers">${notGood.map((c) => answerCard(c, true))}</div>
</section>
${
  good.length > 0 &&
  html`<section>
  <h2>Good answers (${good.length})</h2>
  <div class="answers">${good.map((c) => answerCard(c, false))}</div>
</section>`
}
<section>
  <details class="fold"><summary>What was tested</summary>
    <div class="block"><p class="label">The agent's instructions, version ${card.agent.version}</p><pre>${card.agent.instructions}</pre></div>
  </details>
</section>`;
}

const GLYPH = { met: "pass", "not met": "fail", "not judged": "caution" } as const;

function answerCard(c: ScoredCase, open: boolean): Markup {
  return html`<details class="card answer" ${open && html`open`}>
    <summary>${c.question}</summary>
    ${c.note && html`<p class="hint">Your note: ${c.note}</p>`}
    <div class="block"><p class="label">${c.answer === undefined ? "No answer" : "Answer"}</p>${
      c.answer === undefined ? html`<p>The agent gave no answer: ${c.failure}.</p>` : html`<pre>${c.answer}</pre>`
    }</div>
    <ul class="verdicts">${c.verdicts.map(
      (v) =>
        html`<li class="${GLYPH[v.outcome]}"><span>${v.text}${!v.mustHave && html` <span class="detail">(nice to have)</span>`}${
          v.reason && html`<span class="reason">${v.outcome === "not judged" ? "Not judged" : "Judge"}: ${v.reason}</span>`
        }</span></li>`,
    )}</ul>
  </details>`;
}
