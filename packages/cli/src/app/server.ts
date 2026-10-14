/**
 * The interface as a small web server on this computer. It serves pages only
 * to this computer's own browser, and changes something only for a form that
 * one of its own pages produced.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { compareResults, differences, inOrder, relatedTo } from "./comparison.ts";
import {
  CRITERION_ROWS,
  agentPage,
  cannotComparePage,
  comparePage,
  resultsPage,
  runPage,
  testPage,
  type Chrome,
  type PastRun,
  type TestForm,
} from "./pages.ts";
import { Runs, type Models } from "./runs.ts";
import { scorecardFor } from "./scorecard.ts";
import { InputError, Workspace, parseQuestions } from "./workspace.ts";

export interface AppOptions {
  /** The project folder, recorded with each run. */
  root: string;
  workspaceDir: string;
  models: Models;
  demo: boolean;
  keyFound: boolean;
  /** For tests: the clock that runs are dated by. */
  now?: () => Date;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createApp(options: AppOptions): Server {
  const workspace = new Workspace(options.workspaceDir);
  const runs = new Runs({ root: options.root, runsDir: workspace.runsDir, models: options.models, now: options.now });
  const chrome: Chrome = { token: randomBytes(16).toString("hex"), demo: options.demo, keyFound: options.keyFound };

  const pastRuns = async (): Promise<PastRun[]> => {
    if (!existsSync(workspace.runsDir)) return [];
    const ids = readdirSync(workspace.runsDir).sort().reverse();
    const past: PastRun[] = [];
    for (const runId of ids) {
      const state = await runs.state(runId);
      if (!state) continue;
      past.push({
        runId,
        state,
        scorecard: state.phase === "done" ? await scorecardFor(workspace.runsDir, runId).catch(() => undefined) : undefined,
      });
    }
    return past;
  };

  /** The scorecard of a run that finished, by the run's name; nothing for anything else. */
  const finished = async (runId: string | null) =>
    runId !== null && (await runs.state(runId))?.phase === "done"
      ? scorecardFor(workspace.runsDir, runId).catch(() => undefined)
      : undefined;

  const get = async (url: URL, res: ServerResponse): Promise<void> => {
    const id = url.searchParams.get("id") ?? undefined;
    if (url.pathname === "/") return redirect(res, "/agent");

    if (url.pathname === "/agent") {
      const agent = id === undefined ? undefined : workspace.agent(id);
      const saved = url.searchParams.get("saved");
      return page(
        res,
        agentPage(chrome, workspace.agents(), agent && { id: id!, agent }, {
          saved: saved ? `Saved as version ${saved}.` : undefined,
        }),
      );
    }
    if (url.pathname === "/test") {
      const test = id === undefined ? undefined : workspace.test(id);
      return page(
        res,
        testPage(chrome, workspace.tests(), test && { id: id!, test }, {
          saved: url.searchParams.has("saved") ? "Saved." : undefined,
        }),
      );
    }
    if (url.pathname === "/results") {
      return page(
        res,
        resultsPage(chrome, workspace.agents(), workspace.tests(), await pastRuns(), {
          agent: url.searchParams.get("agent") ?? undefined,
          version: url.searchParams.get("version") ?? undefined,
          test: url.searchParams.get("test") ?? undefined,
        }),
      );
    }
    if (url.pathname === "/compare") {
      const named = (name: string) => finished(url.searchParams.get(name));
      // From a scorecard's own form the two arrive unordered, and are put in the usual order first.
      const [chosen, other] = [await named("run"), await named("with")];
      if (chosen && other) {
        const [first, second] = inOrder(chosen, other);
        return redirect(res, `/compare?a=${first.runId}&b=${second.runId}`);
      }
      const [a, b] = [await named("a"), await named("b")];
      if (!a || !b) return page(res, notFound(), 404);
      const reasons = differences(a, b);
      return reasons.length > 0
        ? page(res, cannotComparePage(chrome, a, b, reasons))
        : page(res, comparePage(chrome, compareResults(a, b)));
    }
    const run = /^\/runs\/([A-Za-z0-9._-]+)$/.exec(url.pathname)?.[1];
    if (run) {
      const state = await runs.state(run);
      if (!state) return page(res, notFound(), 404);
      if (state.phase !== "done") return page(res, runPage(chrome, run, state));
      const scorecard = await scorecardFor(workspace.runsDir, run);
      const others = (await pastRuns()).flatMap((past) => (past.scorecard ? [past.scorecard] : []));
      return page(res, runPage(chrome, run, state, scorecard, relatedTo(scorecard, others)));
    }
    return page(res, notFound(), 404);
  };

  const post = async (url: URL, form: URLSearchParams, res: ServerResponse): Promise<void> => {
    const field = (name: string) => form.get(name) ?? "";
    const id = form.get("id") ?? undefined;

    if (url.pathname === "/agent") {
      const draft = { name: field("name"), model: field("model"), instructions: field("instructions") };
      try {
        const saved = workspace.saveAgent(id, draft);
        return redirect(res, `/agent?id=${saved.id}&saved=${saved.version}`);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        const agent = id === undefined ? undefined : workspace.agent(id);
        return page(res, agentPage(chrome, workspace.agents(), agent && { id: id!, agent }, { draft, error: error.message }), 400);
      }
    }

    if (url.pathname === "/test") {
      const draft: TestForm = {
        name: field("name"),
        questions: field("questions"),
        judgeModel: field("judgeModel"),
        criteria: Array.from({ length: CRITERION_ROWS }, (_, i) => ({
          text: field(`criterion-${i}`),
          mustHave: form.has(`must-${i}`),
        })),
      };
      try {
        const saved = workspace.saveTest(id, { ...draft, questions: parseQuestions(draft.questions) });
        return redirect(res, `/test?id=${saved}&saved=1`);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        const test = id === undefined ? undefined : workspace.test(id);
        return page(res, testPage(chrome, workspace.tests(), test && { id: id!, test }, { draft, error: error.message }), 400);
      }
    }

    if (url.pathname === "/runs") {
      const [agentId = "", versionNumber] = field("agent").split(":");
      const testId = field("test");
      const agent = workspace.agent(agentId);
      const version = agent?.versions.find((v) => String(v.version) === versionNumber);
      const test = workspace.test(testId);
      const fail = async (error: string) =>
        page(res, resultsPage(chrome, workspace.agents(), workspace.tests(), await pastRuns(), { agent: agentId, test: testId, error }), 400);
      if (!agent || !version || !test) return fail("Choose an agent and a test.");
      try {
        return redirect(res, `/runs/${await runs.start({ id: agentId, name: agent.name, version }, testId, test)}`);
      } catch (error) {
        return fail(`The run could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return page(res, notFound(), 404);
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const host = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!LOCAL.has(host)) return text(res, 403, "This lab only answers the computer it runs on.");
        if (req.method === "GET") return await get(url, res);
        if (req.method === "POST") {
          const form = await readForm(req);
          if (form.get("token") !== chrome.token) {
            return text(res, 403, "That form did not come from this session. Reload the page and try again.");
          }
          return await post(url, form, res);
        }
        return text(res, 405, "Method not allowed.");
      } catch (error) {
        text(res, 500, `Something went wrong in the lab: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
}

function page(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location }).end();
}

function notFound(): string {
  return '<!doctype html><meta charset="utf-8"><title>Not found</title><p>There is no such page. <a href="/">Back to the lab</a></p>';
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("the form is too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
