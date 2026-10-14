import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { CandidateUnavailable } from "@agent-quality-lab/core";
import type { ModelClient } from "@agent-quality-lab/models";
import { demoModels } from "./demo.ts";
import type { Models } from "./runs.ts";
import { createApp, type AppOptions } from "./server.ts";

// Nothing in this file calls a model: the interface is driven as a browser would drive it, with stand-ins answering.

const root = resolve(import.meta.dirname, "../../../..");

interface Script {
  /** What the agent says to a question, given its instructions. An Error makes that call fail. */
  answer?: (question: string, instructions: string) => string | Error;
  /** Which criteria the judge finds met, given everything it was shown. An Error makes that call fail. */
  verdicts?: (shown: string) => Record<string, boolean> | Error;
}

/** Stand-ins for the agent's model and the judge. Haiku answers for 0.002 USD a question, Opus judges for 0.006 USD an answer. */
function standIn(script: Script = {}): Models {
  const client = (model: string): ModelClient => ({
    model,
    settings: { provider: "test" },
    start: ({ system, tools }) => ({
      async send(message) {
        const text = "text" in message ? message.text : "";
        if (tools.length === 0) {
          const answer = script.answer?.(text, system) ?? `An answer to "${text}"`;
          if (answer instanceof Error) throw answer;
          return { text: answer, toolRequests: [], usage: { inputTokens: 1000, outputTokens: 200 }, stop: "done" };
        }
        const met = script.verdicts?.(text) ?? {};
        if (met instanceof Error) throw met;
        const verdicts = [...text.matchAll(/^- \[(c\d+)\]/gm)].map(([, criterion]) => ({
          criterion,
          met: met[criterion!] ?? true,
          reason: `Reason for ${criterion}.`,
        }));
        return {
          text: "",
          toolRequests: [{ id: "verdicts", name: "record_verdicts", args: { verdicts } as never }],
          usage: { inputTokens: 1000, outputTokens: 100 },
          stop: "tools",
        };
      },
    }),
  });
  return {
    client,
    prices: {
      currency: "USD",
      asOf: "2026-10-08",
      perMillionTokens: { "claude-haiku-4-5": { input: 1, output: 5 }, "claude-opus-5-5": { input: 4, output: 20 } },
    },
  };
}

/** What a page says, without its markup. */
const words = (page: string) =>
  page
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ");

async function lab(t: TestContext, models: Models, options: Partial<AppOptions> = {}) {
  const dir = options.workspaceDir ?? mkdtempSync(join(tmpdir(), "aql-app-"));
  // A run is named after the second it started in, so each look at the clock is a minute after the last.
  let minute = 0;
  const now = () => new Date(Date.UTC(2026, 9, 8, 10, minute++));
  const server = createApp({ root, workspaceDir: dir, models, demo: false, keyFound: true, now, ...options });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const get = (path: string) => fetch(address + path, { redirect: "manual" });
  const token = /name="token" value="([0-9a-f]{32})"/.exec(await (await get("/agent")).text())![1]!;
  const post = (path: string, fields: Record<string, string>, as = token) =>
    fetch(address + path, { method: "POST", redirect: "manual", body: new URLSearchParams({ token: as, ...fields }) });

  /** Posts a form that is expected to be accepted, and returns the page it leads to. */
  const submit = async (path: string, fields: Record<string, string>) => {
    const response = await post(path, fields);
    assert.equal(response.status, 303, await response.text());
    const location = response.headers.get("location")!;
    return { location, page: await (await get(location)).text() };
  };

  /** Starts a run and waits for the page that replaces the progress page. */
  const run = async (agent: string, testId: string) => {
    const { location } = await submit("/runs", { agent, test: testId });
    for (let tries = 0; tries < 200; tries++) {
      const page = await (await get(location)).text();
      if (!page.includes('http-equiv="refresh"')) return { location, runId: location.replace("/runs/", ""), page };
      await new Promise((wait) => setTimeout(wait, 10));
    }
    throw new Error("the run did not finish");
  };

  return { dir, address, get, post, submit, run };
}

const agentForm = { name: "Cancellation helper", model: "claude-haiku-4-5", instructions: "Always state the fee." };
const testForm = {
  name: "Cancellation questions",
  questions: "Can I cancel for free? | Yes, until Friday\nWhat does it cost?\nIs it refundable?",
  "criterion-0": "States the fee as an amount",
  "must-0": "on",
  "criterion-1": "Names the policy",
  "must-1": "on",
  "criterion-2": "Is polite",
  judgeModel: "claude-opus-5-5",
};

test("the three steps lead from an agent and a test to a scorecard", async (t) => {
  const { dir, get, submit, run } = await lab(
    t,
    standIn({
      verdicts: (shown): Record<string, boolean> =>
        shown.includes("What does it cost?") ? { c2: false } : shown.includes("Is it refundable?") ? { c3: false } : {},
    }),
  );

  const agent = await submit("/agent", agentForm);
  assert.equal(agent.location, "/agent?id=cancellation-helper&saved=1");
  assert.match(words(agent.page), /Saved as version 1\./);
  assert.match(words(agent.page), /Versions Version 1 · Claude Haiku 4\.5 · saved \d{4}-\d\d-\d\d \d\d:\d\d/);

  const saved = await submit("/test", testForm);
  assert.equal(saved.location, "/test?id=cancellation-questions&saved=1");
  assert.match(words(saved.page), /Cancellation questions 3 questions, 3 criteria/);
  assert.match(saved.page, /Can I cancel for free\? \| Yes, until Friday\nWhat does it cost\?\nIs it refundable\?<\/textarea>/);

  const results = words(await (await get("/results?agent=cancellation-helper")).text());
  assert.match(results, /Cancellation helper, version 1 \(Claude Haiku 4\.5\)/);
  assert.match(results, /It stops if the answers cost more than \$5\.00\./);

  const { runId, page } = await run("cancellation-helper:1", "cancellation-questions");
  const card = words(page);
  assert.match(card, /Cancellation questions · \d{4}-\d\d-\d\d \d\d:\d\d Cancellation helper version 1 · Claude Haiku 4\.5 /);
  assert.match(card, /Good answers 2 of 3 Cost of this run \$0\.0240 \$0\.0060 for the answers, \$0\.0180 for judging /);
  assert.match(card, /An answer is good when it meets every must-have\. Judged by Claude Opus 5\.5\./);
  assert.match(card, /States the fee as an amount Must have 3 of 3 Names the policy Must have 2 of 3 Is polite Nice to have 2 of 3 /);

  // The one answer that failed a must-have comes first and open; missing a nice-to-have leaves an answer good.
  assert.match(card, /Answers that were not good \(1\) What does it cost\? Answer An answer to "What does it cost\?"/);
  assert.match(card, /Names the policy Judge: Reason for c2\./);
  assert.match(card, /Good answers \(2\) Can I cancel for free\? Your note: Yes, until Friday /);
  assert.match(card, /Is polite \(nice to have\) Judge: Reason for c3\./);
  assert.match(card, /The agent's instructions, version 1 Always state the fee\./);
  assert.equal(card.includes("could not be judged"), false);
  assert.equal(card.includes("demo"), false);

  assert.match(
    words(await (await get("/results")).text()),
    /Earlier runs When Agent Test Good answers \S+ \S+ Cancellation helper, version 1 Cancellation questions 2 of 3 /,
  );

  // Everything the scorecard shows was written down: the lab's own run format, plus what the judge was and said.
  const files = readdirSync(join(dir, "runs", runId)).sort();
  assert.deepEqual(files, ["agent.json", "dataset.jsonl", "evaluations.jsonl", "judge.jsonl", "manifest.json", "results.jsonl", "test.json"]);
  const manifest = JSON.parse(readFileSync(join(dir, "runs", runId, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.candidate, {
    id: "cancellation-helper",
    version: "v1",
    config: { model: "claude-haiku-4-5", settings: { provider: "test" }, instructions: "Always state the fee." },
    deterministic: false,
  });
  assert.equal(readFileSync(join(dir, "runs", runId, "judge.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("an agent that fails on a question gave no good answer, and an answer the judge failed on is not counted either way", async (t) => {
  const { submit, run } = await lab(
    t,
    standIn({
      answer: (question) => (question === "What does it cost?" ? new Error("the model was overloaded") : "It is free."),
      verdicts: (shown) => (shown.includes("Is it refundable?") ? new Error("the judge was overloaded") : {}),
    }),
  );
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const card = words((await run("cancellation-helper:1", "cancellation-questions")).page);

  assert.match(card, /Good answers 1 of 3 1 could not be judged /);
  // Two answers were paid for and one judgement: the failed calls reported nothing.
  assert.match(card, /Cost of this run \$0\.0100 \$0\.0040 for the answers, \$0\.0060 for judging /);
  assert.match(card, /States the fee as an amount Must have 1 of 1 /);

  assert.match(card, /Answers that could not be judged \(1\) The judge failed on these, .+? Is it refundable\? Answer It is free\. /);
  assert.match(card, /States the fee as an amount Not judged: the judge was overloaded /);
  assert.match(card, /Answers that were not good \(1\) What does it cost\? No answer The agent gave no answer: the model was overloaded\. /);
  assert.match(card, /States the fee as an amount Not judged: there was no answer to read /);
  assert.match(card, /Good answers \(1\) Can I cancel for free\? /);
});

test("a run that cannot reach its model stops and says why, in place of a scorecard full of failures", async (t) => {
  const { get, submit, run } = await lab(
    t,
    standIn({ answer: () => new CandidateUnavailable("the Anthropic API could not be used: no API key") }),
  );
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const { page, location } = await run("cancellation-helper:1", "cancellation-questions");

  assert.match(words(page), /This run did not finish It stopped because the agent could not run: the Anthropic API could not be used: no API key\./);
  assert.equal(words(page).includes("Good answers"), false);
  assert.match(words(await (await get("/results")).text()), /Earlier runs .+ stopped /);
  assert.equal((await get(location)).status, 200);
});

test("a later edit to the agent or the test does not change a scorecard that was already there", async (t) => {
  const { get, submit, run } = await lab(t, standIn());
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const { location, page } = await run("cancellation-helper:1", "cancellation-questions");

  const edited = await submit("/agent", { ...agentForm, id: "cancellation-helper", name: "Refund helper", instructions: "State the fee and the policy." });
  assert.equal(edited.location, "/agent?id=cancellation-helper&saved=2");
  await submit("/test", { ...testForm, id: "cancellation-questions", name: "Refund questions", "criterion-0": "Mentions a refund" });

  assert.equal(words(await (await get(location)).text()), words(page));
  const choices = words(await (await get("/results")).text());
  assert.match(choices, /Refund helper, version 2 \(Claude Haiku 4\.5\) Refund helper, version 1 \(Claude Haiku 4\.5\)/);
});

test("a form that cannot be saved comes back with what was typed and what is missing", async (t) => {
  const { dir, post } = await lab(t, standIn());

  const agent = await post("/agent", { ...agentForm, instructions: " " });
  assert.equal(agent.status, 400);
  const agentPage = await agent.text();
  assert.match(agentPage, /<p class="error" role="alert">Write the agent&#39;s instructions\.<\/p>/);
  assert.match(agentPage, /name="name" value="Cancellation helper"/);

  const { "must-0": _, "must-1": __, ...noMustHave } = testForm;
  const saved = await post("/test", noMustHave);
  assert.equal(saved.status, 400);
  const testPage = await saved.text();
  assert.match(words(testPage), /Mark at least one criterion as a must-have\./);
  assert.match(testPage, /name="criterion-1" value="Names the policy"/);
  assert.match(testPage, /What does it cost\?\nIs it refundable\?<\/textarea>/);

  const started = await post("/runs", { agent: "no-such-agent:1", test: "no-such-test" });
  assert.equal(started.status, 400);
  assert.deepEqual(readdirSync(dir), []);
});

test("what a person or a model wrote is shown as text and never becomes part of the page", async (t) => {
  const attack = '<script>alert("x")</script>';
  const { get, submit, run } = await lab(t, standIn({ answer: () => `${attack} <img src=x onerror=alert(1)>` }));
  const agent = await submit("/agent", { ...agentForm, name: attack, instructions: `</textarea>${attack}` });
  const saved = await submit("/test", { ...testForm, name: attack, questions: `${attack} | ${attack}`, "criterion-0": attack });
  const { page } = await run("script-alert-x-script:1", "script-alert-x-script");

  for (const shown of [agent.page, saved.page, page, await (await get("/results")).text()]) {
    assert.equal(/<script|<img|onerror=alert\(1\)>/.test(shown), false);
    assert.ok(shown.includes("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;"));
  }
});

test("the lab answers only this computer, and changes something only for a form from one of its own pages", async (t) => {
  const { dir, address, get, post } = await lab(t, standIn());

  const elsewhere = await new Promise<number>((done, failed) =>
    request(`${address}/agent`, { headers: { host: "lab.example.com" } }, (response) => done(response.statusCode!))
      .on("error", failed)
      .end(),
  );
  assert.equal(elsewhere, 403);

  for (const token of ["", "0".repeat(32)]) {
    const response = await post("/agent", agentForm, token);
    assert.equal(response.status, 403);
    assert.match(await response.text(), /That form did not come from this session/);
  }
  assert.deepEqual(readdirSync(dir), []);

  assert.equal((await get("/")).headers.get("location"), "/agent");
  assert.equal((await get("/no-such-page")).status, 404);
  assert.equal((await get("/runs/no-such-run")).status, 404);
  assert.equal((await get("/runs/..%2F..%2Fpackage.json")).status, 404);
  assert.equal((await fetch(`${address}/agent`, { method: "DELETE" })).status, 405);
});

test("without an API key the lab says so and does not offer to run", async (t) => {
  const { get, submit } = await lab(t, standIn(), { keyFound: false });
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const results = await (await get("/results")).text();

  assert.match(words(results), /No API key was found, so tests cannot run yet\./);
  assert.match(results, /<button class="primary" disabled>Run test<\/button>/);
});

test("a demo run says that it is one, on its scorecard and in the list, also once the lab is no longer in demo mode", async (t) => {
  const demo = await lab(t, demoModels(), { demo: true, keyFound: false });
  await demo.submit("/agent", agentForm);
  await demo.submit("/test", testForm);

  const results = await (await demo.get("/results")).text();
  assert.match(words(results), /Demo mode\. No model is called, so answers and verdicts are placeholders/);
  assert.match(words(results), /Demo mode: nothing is called and nothing is charged\./);
  assert.match(results, /<button class="primary" >Run test<\/button>/);

  const { location, page } = await demo.run("cancellation-helper:1", "cancellation-questions");
  const describes = (card: string) => {
    assert.match(card, /Cancellation helper version 1 · no model \(demo\) This was a demo run\. No model was called, /);
    assert.match(card, /Cost of this run \$0\.0000 /);
    assert.match(card, /Judged by no model \(demo\)\./);
  };
  describes(words(page));

  const real = await lab(t, standIn(), { workspaceDir: demo.dir });
  describes(words(await (await real.get(location)).text()));
  assert.match(words(await (await real.get("/results")).text()), /Cancellation questions \d of 3 \(demo\) /);
});

// --- Two results side by side ---------------------------------------------------

/** Version 1 leaves the policy out, version 2 names it, and the judge notices. */
const policyMatters = (): Models =>
  standIn({
    answer: (_question, instructions) =>
      instructions.includes("policy") ? "Under the flexible policy the fee is 300 EUR." : "The fee is 300 EUR.",
    verdicts: (shown) => ({ c2: shown.includes("Under the flexible policy") }),
  });
const withPolicy = { ...agentForm, id: "cancellation-helper", instructions: "State the fee and the policy." };

test("a new version's scorecard leads to the version before, and the two are shown side by side", async (t) => {
  const { get, submit, run } = await lab(t, policyMatters());
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const v1 = await run("cancellation-helper:1", "cancellation-questions");
  assert.equal(words(v1.page).includes("Compare with"), false, "there is nothing to compare a first result with");

  await submit("/agent", withPolicy);
  const v2 = await run("cancellation-helper:2", "cancellation-questions");
  const pair = `/compare?a=${v1.runId}&b=${v2.runId}`;
  assert.match(words(v2.page), /Version 1 had 0 of 3 on this test\. See the two side by side /);
  assert.ok(v2.page.includes(`<a href="${pair.replace("&", "&amp;")}">See the two side by side</a>`));
  assert.match(words(v2.page), /Compare with Cancellation helper, version 1 · \S+ \S+ · 0 of 3 Compare /);

  // The scorecard's own form names the two in either order; the lower version goes first.
  for (const [chosen, other] of [[v2, v1], [v1, v2]]) {
    const ordered = await get(`/compare?run=${chosen!.runId}&with=${other!.runId}`);
    assert.deepEqual([ordered.status, ordered.headers.get("location")], [303, pair]);
  }

  const page = words(await (await get(pair)).text());
  assert.match(page, /Cancellation questions · 3 questions Cancellation helper version 1 compared with version 2 /);
  assert.match(page, /Good answers 0 of 3 → 3 of 3 Cost of a run \$0\.0240 → \$0\.0240 /);
  assert.match(page, /3 got better 0 got worse 0 stayed the same Too small a difference to tell from chance\./);
  assert.match(page, /Names the policy Must have 0 of 3 3 of 3 /);
  assert.match(page, /Got worse \(0\) None\. Got better \(3\) Can I cancel for free\? Your note: Yes, until Friday /);
  assert.match(page, /Version 1 · not good The fee is 300 EUR\. .+? Version 2 · good Under the flexible policy the fee is 300 EUR\. /);
  assert.match(
    page,
    /What was different Version 1 · Claude Haiku 4\.5 Always state the fee\. Version 2 · Claude Haiku 4\.5 State the fee and the policy\./,
  );
  assert.equal(page.includes("Not good in both"), false);
  assert.equal(page.includes("could not be compared"), false);

  const swapped = words(await (await get(`/compare?a=${v2.runId}&b=${v1.runId}`)).text());
  assert.match(swapped, /Cancellation helper version 2 compared with version 1 /);
  assert.match(swapped, /Good answers 3 of 3 → 0 of 3 .+ 0 got better 3 got worse 0 stayed the same /);
});

test("a difference is called more than chance once enough answers moved the same way", async (t) => {
  const { get, submit, run } = await lab(t, policyMatters());
  const six = { ...testForm, questions: ["One?", "Two?", "Three?", "Four?", "Five?", "Six?"].join("\n") };
  await submit("/agent", agentForm);
  await submit("/test", six);
  const v1 = await run("cancellation-helper:1", "cancellation-questions");
  await submit("/agent", withPolicy);
  const v2 = await run("cancellation-helper:2", "cancellation-questions");

  const page = words(await (await get(`/compare?a=${v1.runId}&b=${v2.runId}`)).text());
  assert.match(page, /6 got better 0 got worse 0 stayed the same More than chance usually produces\./);
});

test("the same version run twice is compared as two runs, with nothing said to be different", async (t) => {
  const { get, submit, run } = await lab(t, policyMatters());
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const first = await run("cancellation-helper:1", "cancellation-questions");
  const second = await run("cancellation-helper:1", "cancellation-questions");
  assert.equal(words(second.page).includes("See the two side by side"), false, "there is no version before version 1");

  const ordered = await get(`/compare?run=${second.runId}&with=${first.runId}`);
  assert.equal(ordered.headers.get("location"), `/compare?a=${first.runId}&b=${second.runId}`);
  const page = words(await (await get(ordered.headers.get("location")!)).text());
  assert.match(page, /Cancellation helper version 1, two runs compared /);
  assert.match(page, /0 got better 0 got worse 3 stayed the same No answer went from good to not good, or back\./);
  assert.match(page, /Not good in both \(3\) .+ Earlier run · not good The fee is 300 EUR\. .+ Later run · not good /);
  assert.match(page, /What was different Nothing: both sides are runs of the same version, /);
});

test("a result from before the test was edited is not offered, and the scorecard says why and what to do", async (t) => {
  const { get, submit, run } = await lab(t, policyMatters());
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const v1 = await run("cancellation-helper:1", "cancellation-questions");

  await submit("/test", { ...testForm, id: "cancellation-questions", questions: `${testForm.questions}\nWho pays the fee?` });
  await submit("/agent", withPolicy);
  const v2 = await run("cancellation-helper:2", "cancellation-questions");
  const again = "/results?agent=cancellation-helper&version=1&test=cancellation-questions";

  const card = words(v2.page);
  assert.match(
    card,
    /Version 1 has a result on this test that cannot be put next to this one\. The test's questions or their notes were changed in between\. To compare the two, run version 1 again on the test as it is now\./,
  );
  assert.ok(v2.page.includes(`<a href="${again.replaceAll("&", "&amp;")}">run version 1 again</a>`));
  assert.equal(card.includes("See the two side by side"), false);
  assert.equal(card.includes("Compare with"), false);
  assert.match(await (await get(again)).text(), /<option value="cancellation-helper:1" selected>/);

  const refused = await get(`/compare?a=${v1.runId}&b=${v2.runId}`);
  assert.equal(refused.status, 200);
  const page = words(await refused.text());
  assert.match(page, /These two results cannot be put side by side .+ The test's questions or their notes were changed in between\. /);
  assert.equal(page.includes("got better"), false);

  // Run again on the test as it is now, version 1 can be compared after all.
  const rerun = await run("cancellation-helper:1", "cancellation-questions");
  const offered = words(await (await get(v2.location)).text());
  assert.match(offered, /Version 1 had 0 of 4 on this test\. See the two side by side /);
  assert.equal((await get(`/compare?run=${v2.runId}&with=${rerun.runId}`)).status, 303);
});

test("a demo result is never put next to a real one", async (t) => {
  const demo = await lab(t, demoModels(), { demo: true });
  await demo.submit("/agent", agentForm);
  await demo.submit("/test", testForm);
  const placeholder = await demo.run("cancellation-helper:1", "cancellation-questions");

  const real = await lab(t, policyMatters(), { workspaceDir: demo.dir, now: () => new Date("2026-10-09T10:00:00Z") });
  await real.submit("/agent", withPolicy);
  const measured = await real.run("cancellation-helper:2", "cancellation-questions");

  const card = words(measured.page);
  assert.equal(card.includes("Compare with"), false);
  assert.equal(card.includes("Version 1 ha"), false);
  const refused = words(await (await real.get(`/compare?a=${placeholder.runId}&b=${measured.runId}`)).text());
  assert.match(refused, /cannot be put side by side .+ One of them is a demo run, in which no model was called\./);
});

test("only finished results can be compared", async (t) => {
  const { get, submit, run } = await lab(
    t,
    standIn({ answer: () => new CandidateUnavailable("the Anthropic API could not be used: no API key") }),
  );
  await submit("/agent", agentForm);
  await submit("/test", testForm);
  const stopped = await run("cancellation-helper:1", "cancellation-questions");

  assert.equal((await get(`/compare?a=${stopped.runId}&b=${stopped.runId}`)).status, 404);
  assert.equal((await get("/compare?a=no-such-run&b=no-such-run")).status, 404);
  assert.equal((await get("/compare")).status, 404);
  assert.equal((await get(`/compare?run=${stopped.runId}&with=..%2F..`)).status, 404);
});
