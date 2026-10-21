# Agent Quality Lab

A small lab for testing and comparing agentic systems. Give the same task to different implementations, record what each one observably did, and compare them case by case.

An implementation can be anything that takes the task input and returns a result: a model with a prompt, a tool-using agent, a workflow engine, a plain program. The lab does not care how it works inside and never asks for hidden reasoning.

There are two ways to use it:

- **In the browser**, without writing code: describe an agent in words, describe what a good answer looks like, and read a scorecard. See [Testing an agent in the browser](#testing-an-agent-in-the-browser).
- **On the command line**, for tasks written as code: scenarios with their own tools and checks, and a case-by-case comparison of two implementations. See [Running a comparison](#running-a-comparison).

Both run on the same engine and store their results in the same format.

**Status:** an early version. It ships with a first version of the interface, two synthetic scenarios, four plain programs as candidates, a candidate that hands a task to a Claude model, and a scenario that re-scores the stored runs of three real systems. See [Known limitations](#known-limitations).

## Testing an agent in the browser

The interface is for people who build agents without being engineers and want to know how good their agent is. It runs on your own computer and has three steps:

1. **What are you testing?** An agent here is a set of instructions and a model. Each change to the instructions is saved as a new version, so a result always says which version it tested.
2. **What should it do?** A test is a list of example questions, each with an optional note about the right answer, and a few plain sentences that describe a good answer, such as "States the fee as an amount". Each sentence is marked as a must-have or a nice-to-have.
3. **How did it do?** The agent answers every question. A second model, the judge, then reads every answer and decides each sentence with yes or no, giving one sentence of reasoning. The scorecard says how many answers were good, meaning they met every must-have, and shows each answer with the judge's verdicts and reasons.

It requires Node.js 24 or later.

```bash
npm install
```

To try it without calling a model or paying anything, start it in demo mode. Answers and verdicts are then placeholders, and every page that shows them says so:

```bash
npx aql ui --demo
```

To test an agent for real, put an Anthropic API key in the environment as `ANTHROPIC_API_KEY` and start it without the flag:

```bash
npx aql ui
```

A real run calls the agent's model once per question and the judge once per answer, and shows what both cost. It stops if the answers cost more than 5 US dollars.

What the scorecard counts:

- An answer is good when the judge finds every must-have met. Nice-to-haves are shown and do not decide it.
- A question the agent failed on, for example because the request to the model failed, has no good answer. The scorecard shows why.
- An answer the judge failed on is counted as neither good nor not good, and is listed separately.
- A run that cannot reach its model at all stops and says why. It does not produce a scorecard full of failures.

### Did a change help?

Change an agent's instructions, save, and run the same test again. The new scorecard says what the version before scored and leads to the two side by side: the headline figures before and after, each criterion for both, and every question with both answers and both sets of verdicts. The questions whose answer got worse come first, then the ones that got better.

Any two results of the same test can be compared this way, also two different agents, or the same version run twice to see how much a result moves by itself.

- Two results are compared only if they answered the same questions and were judged against the same criteria by the same judge. If the test was edited in between, the lab says what changed and does not compare them; run the older version again on the test as it is now.
- The page says whether the difference is more than chance. It counts the answers that went from good to not good or back, and asks how often a split at least that one-sided would turn up if both sides were equally good. Below 1 time in 20 it calls the difference more than chance; otherwise it says the difference is too small to tell. A short test rarely gets there: it takes at least six changed answers, all in the same direction.
- An answer the judge failed on, on either side, is called neither better nor worse.
- A demo result is never compared with a real one.

Your agents, tests and results are kept as plain files in `workspace/`, which git ignores, so your instructions stay on your computer unless you publish them yourself. Each result is an ordinary [run](#run-files), plus the test as it was when it ran and what the judge said.

The interface answers only the computer it runs on.

## The problem

Most evaluations of agents score the final answer. That leaves out things that matter when deciding which system to use:

- Did it use the right tools, and only as often as needed?
- Did it abstain when it could not know the answer?
- When a tool failed, did it recover, or did it quietly guess?
- Did a failure get turned into a valid-looking result somewhere along the way?
- What did the run cost in time, tool calls and tokens?

## Why the final answer is not enough

The scenario that ships with the lab asks whether an order can be fulfilled, which the candidate can only find out through a stock lookup tool. In the case `flaky-lookup`, the first lookup fails. Two candidates return the same, correct answer:

| Candidate | What it did | Answer | Correctness | Tool use |
|---|---|---|---|---|
| baseline | The lookup failed, it retried and read the real stock level | `canFulfil: true` | pass | pass |
| mock-agent | The lookup failed, it fell back to a guess | `canFulfil: true` | pass | fail: answered although no lookup succeeded |

A check of the final answer scores these two the same. The trace shows they are not the same. On the next case, where the right answer is `false`, the same guess is wrong.

## How it works

| Concept | What it is |
|---|---|
| **Scenario** | A task: written instructions, input and output schemas, datasets, the tools a candidate may call, evaluators and a time limit per case |
| **Candidate** | An implementation under test. It implements one function that takes a case input and returns an answer or an abstention |
| **Evaluator** | Judges one aspect of a completed case: pass, fail or not applicable. Several evaluators run on the same result |
| **Run** | One candidate executed on one dataset of one scenario, stored as files |
| **Comparison** | Two runs of the same scenario and dataset, side by side and case by case |

### What a run records

Every case ends in exactly one of four ways and is recorded as what it was:

| Status | Meaning |
|---|---|
| `completed` | Returned an answer or an abstention that fits the scenario's output schema |
| `malformed_output` | Returned something else. The returned value is kept |
| `error` | Threw an error |
| `timeout` | Exceeded the time limit |

Abstaining is a valid result, not a failure. Whether it was the right thing to do is for an evaluator to decide.

Next to the result, the lab records a trace: tool calls with their arguments, results, errors and durations, plus model calls and fallbacks. Each event is marked `observed` when the lab saw it happen, because the call went through a tool the scenario provides, or `reported` when the candidate said it happened. A reported event is weaker evidence.

A few rules keep the numbers honest:

- The runner never retries a case and never substitutes an output.
- Evaluators only see completed cases. A case that did not complete has no answer to judge: it is recorded as `not_evaluated` for every evaluator, and every pass count shows it beside the count, as in "6/9 + 3 without an answer". It is never dropped, and never read as an answer that was judged.
- A pass count is out of the answers an evaluator judged. Cases it calls not applicable are left out and shown in their own column.
- An evaluator that throws is recorded as an evaluator error. It is neither a pass nor a fail for the candidate.
- Every candidate is given the same instructions and the same tools, described the same way. A run records both.
- Two runs are only compared if they used the same scenario version, instructions, tools, dataset, time limit and evaluator versions. Otherwise `aql compare` refuses and lists the reasons.

### Run files

Runs are plain files, so they can be read, diffed and scored again without the lab:

```text
runs/<run-id>/
  manifest.json      what was executed: scenario, what candidates were told, dataset hash, candidate, config, git commit, runtime
  dataset.jsonl      a snapshot of the cases the run used
  results.jsonl      one line per case: status, output, trace, duration
  evaluations.jsonl  one line per case and evaluator: the verdict and its reason
```

Execution and scoring are separate steps. A stored run can be scored again with fixed or new evaluators without running the candidate again.

## Running a comparison

Requires Node.js 24 or later and `npm install`, as above. There is no build step.

Run both candidates of the example scenario. Each command executes the candidate, writes a run to `runs/` and prints a summary:

```bash
npx aql run stock-check --candidate baseline
npx aql run stock-check --candidate mock-agent
```

Compare the two runs. A run is named by its id, which is its directory name under `runs/`, or by a path. With exactly one run of each candidate, a glob is the shortest way:

```bash
npx aql compare runs/*_stock-check_baseline runs/*_stock-check_mock-agent
```

Add `--html` to also write the comparison as one self-contained page, with every case's output, verdicts and trace for both sides:

```bash
npx aql compare runs/*_stock-check_baseline runs/*_stock-check_mock-agent --html runs/report.html
```

To score a stored run again with the scenario's current evaluators:

```bash
npx aql eval runs/*_stock-check_mock-agent
```

The same commands work for `travel-cancellation`, whose candidates are `rules` and `naive`.

### Running a model

`haiku`, `sonnet` and `opus` are candidates that hand the task to a Claude model. They work for any scenario, because everything they tell the model comes from the scenario: its instructions, its tools and the shape of an answer. They call the Anthropic API, so they need credentials in the environment (`ANTHROPIC_API_KEY`) and they cost money.

```bash
npx aql run travel-cancellation --candidate haiku --concurrency 4
```

- `--concurrency` runs several cases at once. A model takes seconds per case.
- `--max-cost` stops a run once its model calls have cost more than the given number of US dollars. The default is 5.
- Each result is saved as it arrives. A run that is stopped or interrupted keeps what it had, is marked incomplete, and cannot be scored or compared.
- A run that cannot start at all, for example without credentials, stops at once and saves nothing.

A run records the prices its cost was worked out from, so the figure can be checked later.

### Importing answers produced elsewhere

A system that already ran somewhere else can be scored without running it again. Its answers go in a JSON file, one per case of the dataset, and `aql import` loads them as a run of the scenario and scores it:

```text
npx aql import <scenario> <answers-file> --dataset <name>
```

The file names the system and lists its answers: `{ "candidate": { "id", "version", "config" }, "startedAt", "tools", "answers": [ ... ] }`, where each answer is `{ "caseId", "answer" }`, `{ "caseId", "abstain" }` or `{ "caseId", "error" }`. An answer is checked exactly as a candidate's would be, so one that does not fit the scenario is malformed output, not mapped onto something that fits. An import that does not cover every case is refused.

`tools` says which tools the system could call. When it is given, every answer brings the calls it made as `"toolCalls": [{ "name", "args", "result" or "error" }]`, an empty list when it made none, and they go into the trace as reported by the source. When it is left out, the system's tool calls are not known: the report shows them as "not imported", not as zero, and a check that reads tool calls does not judge the run.

An imported run says where its answers came from. It records no durations, no settings and no instructions, because the lab did not watch the answers being made. Two imported runs of the same dataset can be compared like any other two runs.

### Repeated runs

A model does not answer the same way twice, so one run of it is one sample. `aql overview` shows every system that ran on a dataset, with each check as a range over its runs:

```bash
npx aql overview stock-check
```

- Runs of the same candidate, version and settings, on the same dataset under the same conditions, are repeats of each other. The lab recognises them by itself.
- Each check is shown as the share of judged answers that passed, from the lowest run to the highest. A run with cases without an answer is marked.
- A difference between two systems is called only when each ran at least 3 times, every case has an answer in every run, and their ranges do not overlap. Anything less is said as what it is: too few runs, answers missing, or ranges that overlap.
- For a system with more than one run, the overview lists the cases it got right every time, wrong every time, and right only sometimes. A case wrong every time points at the instructions or the task; one right only sometimes is chance. A case without an answer in some run is listed apart.

Add `--html <file>` to also write the overview as one page.

## The scenarios

| Scenario | The task | What it stresses |
|---|---|---|
| `stock-check` | Can an order for some units of an item be fulfilled? One lookup tool. 12 cases | Every way a case can end, abstaining, a tool that fails, guessing |
| `travel-cancellation` | What does it cost to cancel this booking? Six lookup tools, four of them needed. 24 cases | Policy rules, time zones, a source that should not be trusted, records that contradict each other, escalating to a human |
| `reddit-signal` | Which of five labels does a Reddit travel post get? 91 hand-labelled posts, labelled twice | Real systems: the stored runs of three projects, re-scored and broken down by which label was mistaken for which |

In `travel-cancellation` every case has its own small world of made-up records, and its own things that go wrong. It separates two ways of not answering: abstaining when the facts cannot be obtained, and escalating when the records were obtained but contradict each other. An escalation is an ordinary answer that this scenario defines; the lab itself only knows answers and abstentions.

`reddit-signal` holds no posts: they are other people's writing, and are read from the projects on the computer the lab runs on. Its [README](scenarios/reddit-signal/README.md) says how, and shows that the lab arrives at every figure the three projects reported for their stored runs.

For a check that sorts cases into labels, a run's report also shows each label's precision and recall, and which label was mistaken for which. A share of right answers hides the shape of the mistakes: a system that files everything under the most common label can still score well.

## Example results

### stock-check

The `stock-check` scenario has 12 cases. In three of them the right behaviour is to abstain, and in three the lookup tool fails.

| | baseline | mock-agent |
|---|---:|---:|
| Completed | 12/12 | 9/12 |
| Malformed output | 0 | 1 |
| Error | 0 | 1 |
| Timeout | 0 | 1 |
| Fallbacks | 0 | 3 |
| Correctness: pass | 12/12 | 6/9 + 3 without an answer |
| Tool use: pass | 12/12 | 5/9 + 3 without an answer |
| Tool calls | 15 (4 failed) | 11 (3 failed) |

Below the totals, the comparison breaks the counts down by tag and lists the cases behind every difference:

```text
tag             cases  completed A · B  correctness pass A · B           tool-use pass A · B
boundary        5      5/5 · 4/5        5/5 · 3/4 + 1 without an answer  5/5 · 3/4 + 1 without an answer
should-abstain  3      3/3 · 2/3        3/3 · 1/2 + 1 without an answer  3/3 · 1/2 + 1 without an answer
tool-failure    3      3/3 · 3/3        3/3 · 1/3                        3/3 · 0/3

by evaluator
  correctness  passes only in A (6)  in-stock, small-exact, small-one-over, unknown-item, flaky-lookup-over, service-down
  tool-use     passes only in A (7)  in-stock, in-stock-exact, small-exact, unknown-item, flaky-lookup, flaky-lookup-over, service-down

cases that differ in status or verdicts (8 of 12)
  flaky-lookup       A  answer {"canFulfil":true}, 2 tool calls
                     B  answer {"canFulfil":true}, 1 tool call, fallback, fails tool-use
  service-down       A  abstain, 2 tool calls
                     B  answer {"canFulfil":true}, 1 tool call, fallback, fails correctness and tool-use
  ...
```

### travel-cancellation

`rules` follows the task's rules step by step. `naive` makes four typical mistakes: it reads check-in times as UTC, believes the property's own description, never escalates, and gives up after one failed lookup. Both work out when the traveler means to cancel from the single word "tomorrow".

| | rules | naive |
|---|---:|---:|
| Completed | 24/24 | 24/24 |
| Outcome: pass | 24/24 | 21/24 |
| Amount: pass | 14/18 | 9/18 |
| Evidence: pass | 24/24 | 23/24 |
| Tool use: pass | 24/24 | 24/24 |

The amount check applies to the 18 cases where a fee is due. The breakdown by tag, abridged here, says where each one goes wrong:

```text
tag                  cases  outcome pass A · B  amount pass A · B
boundary             2      2/2 · 2/2           2/2 · 2/2
time-zone            2      2/2 · 2/2           2/2 · 0/2
conflicting-content  2      2/2 · 2/2           2/2 · 0/2
should-escalate      2      2/2 · 0/2           n/a
should-abstain       4      4/4 · 4/4           n/a
reworded             4      4/4 · 4/4           0/4 · 0/4
...
```

`naive` gets every time-zone case and every case with a misleading property page wrong, and never escalates. Both programs get all four reworded questions wrong, such as "what would it cost to cancel in 48 hours?": a rule keyed to one word cannot read them. Everything else `rules` gets right.

Both examples are reproducible: all four candidates are deterministic, so every run gives the same statuses, outputs and verdicts. Durations differ from run to run.

## What this evidence does and does not support

All four candidates in these examples are synthetic programs. In `stock-check`, `baseline` is a short program and `mock-agent` has no model behind it: it is a stand-in with seeded faults, built so that a single run exercises every way a case can end. The token counts it reports are made up. In `travel-cancellation`, `naive` was written to make four chosen mistakes.

The example supports these statements:

- The lab keeps completed, malformed, errored and timed-out cases apart, and counts the last three against the candidate.
- A right answer reached by guessing is caught by an evaluator that reads the trace, where a check of the final answer passes it.
- A second task from a different domain fits without any of its vocabulary in the lab's core.
- A weakness confined to one kind of case stays visible in the breakdown by tag, where the totals blur it.
- Every count in a summary or comparison can be traced to the cases behind it.
- Answers stored by real systems outside the lab can be re-scored by it: for `reddit-signal`, the lab arrives at the figures each of three projects reported for its own runs.

It does not support these:

- Anything about a real model, agent or framework, beyond the `reddit-signal` runs. Those were made by real systems outside the lab and re-scored here; the lab ran none of them.
- That the mock agent's failure rates, or the naive candidate's mistakes, resemble any real system.
- That the abstractions fit very different agents. Three scenarios have exercised them; the only real systems among the candidates ran outside the lab.
- That an explanation is any good. `travel-cancellation` records the explanation each answer gives and no check judges it.
- That the judge in the interface is right. It has only been run with stand-ins in place of models, and nobody has compared its verdicts with a person's.
- Anything about latency or cost. The durations are those of local function calls, and the mock agent's calls are priced at zero.

## Known limitations

Scope:

- There are two synthetic scenarios. One model provider is supported, Anthropic, and no agent framework. On the command line, a candidate is a TypeScript module.
- In the interface, an agent is instructions and a model. It has no tools, an agent that runs somewhere else cannot be connected, and answers produced elsewhere cannot be loaded.
- In the interface, each question is asked on its own. There are no conversations of several turns.
- The interface compares two results at a time. It does not show how an agent did across more than two versions.

Measurement:

- `aql compare` uses one run per side, which is why it describes differences and calls none of them a regression. `aql overview` shows repeated runs as ranges, but its rule is deliberately simple: with 3 runs a range is a rough measure of noise, and the lab does not yet run repeats itself; they come from running a candidate several times or from imports. A scorecard in the interface is one run as well: a model does not answer the same way twice, so the same test can give a different count the next time. The interface's side-by-side view says whether a difference is more than chance, which guards against reading too much into a small one; it is still one run per side, and comparing many versions makes it likelier that one of them clears that bar by luck.
- The lab sees only what goes through its own tools. A candidate's own tool calls, model calls and fallbacks appear only if the candidate reports them. A silent fallback inside an opaque candidate cannot be detected.
- Model calls and their token counts are reported by the candidate. For the model candidates they are the provider's own figures, passed on.
- A cost is those token counts at a price list kept in the repository by hand and saved with each run. It is not the provider's bill, and the list can go out of date. A call that cannot be priced is counted as such, not as free.
- A request the provider fails, for example under a rate limit, is recorded as an error of that case, which then has no answer, although the candidate did nothing wrong. Such a run is better repeated.
- Durations are wall-clock time on the machine that ran the lab, summarised as median and maximum.
- Versions of scenarios, candidates and evaluators are strings their authors declare. The lab records them with the dataset hash and the git commit, but cannot check that a version was changed when behaviour changed.
- The scenarios' evaluators are deterministic code. In the interface the judge is a model, and a model can be wrong. Nothing yet measures how often it agrees with a person, and there is no human review.
- The interface's spending limit covers the agent's answers. Judging is priced and shown, but not limited.
- An evaluator cannot judge the trace of a case that did not complete.
- An imported run's tool calls are what the source recorded and reported. The lab saw none of them, and records the evidence as weaker for it.

Engineering:

- An incomplete run cannot be resumed. It has to be run again from the start.
- A candidate that exceeds the time limit is signalled to stop, not killed.
- `aql eval` replaces all of a run's evaluations.
- A candidate's configuration cannot be changed from the command line. A different model or setting is a different candidate file.
- The run format is at version 1 and may change.
- Runs and HTML reports contain the dataset's inputs and expected values. Keep that in mind before publishing them for a held-out set.

## Adding a scenario or a candidate

The CLI finds scenarios and candidates by location:

```text
scenarios/<scenario>/
  scenario.ts          default-exports the scenario; its id must match the directory name
  datasets/*.jsonl     one case per line: id, input, and optionally expected, setup and tags
  candidates/<name>.ts default-exports a candidate for this scenario

candidates/<name>.ts   default-exports a candidate that works for any scenario
```

A scenario states its task as written instructions, says what shape an answer has, and gives each of its tools a description and the arguments it accepts. A candidate that has to be told what to do, such as a model, reads them; a plain program can ignore them.

Tags are free labels on a case, such as `boundary` or `tool-failure`. Summaries, comparisons and the HTML report repeat every count per tag, so a weakness on one kind of case stays visible.

A case can carry a `setup`: the facts of that one case, such as what a lookup returns or which service is down. The scenario builds the case's tools from it and evaluators can read it, but the candidate never receives it. `travel-cancellation` uses one for every case; in `stock-check` the tools behave the same way for every case.

An evaluator whose verdict depends on the tool calls in the trace says so with `readsToolCalls: true`. On a run whose tool calls were not recorded, the lab then records "not applicable" for it instead of reading an empty trace as no calls. An evaluator is also told which tools the candidate could call, when the run knows, so it can tell a candidate that skipped a tool from one that never had it.

[scenarios/stock-check](scenarios/stock-check) is the smallest complete example. [scenarios/travel-cancellation](scenarios/travel-cancellation) shows a setup per case, and [scenarios/travel-shared](scenarios/travel-shared) holds the made-up marketplace that further travel scenarios can reuse. The contracts a scenario and a candidate implement are in [packages/core/src/types.ts](packages/core/src/types.ts), and the format of the run files is in [packages/core/src/artifact.ts](packages/core/src/artifact.ts).

## Repository layout

```text
packages/core    run format, runner, evaluation, summaries, cost and comparison. No dependency on the CLI
packages/cli     the aql command, the text and HTML rendering, and the interface in the browser
packages/models  candidates that hand a task to a model, the judge, and the one file that talks to a model provider
scenarios        scenarios with their datasets and candidates
candidates       candidates that work for any scenario
runs             written by aql run; ignored by git
workspace        your agents, tests and results from the interface; ignored by git
```

Core returns plain data and the CLI only formats it. The interface in the browser reads the same run files and calls the same functions as the command line.

## Development

```bash
npm test
npm run typecheck
```
