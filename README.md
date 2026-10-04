# Agent Quality Lab

A small lab for testing and comparing agentic systems. Give the same task to different implementations, record what each one observably did, and compare them case by case.

An implementation can be anything that takes the task input and returns a result: a model with a prompt, a tool-using agent, a workflow engine, a plain program. The lab does not care how it works inside and never asks for hidden reasoning.

**Status:** an early version. It ships with two synthetic scenarios and has no adapter for any real model or agent yet. See [Known limitations](#known-limitations).

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
| **Scenario** | A task: input and output schemas, datasets, the tools a candidate may call, evaluators and a time limit per case |
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
- Evaluators only see completed cases. A case that did not complete is recorded as `not_evaluated` for every evaluator and counts against the candidate.
- A pass count is out of the cases an evaluator applies to. Cases it calls not applicable are left out and shown in their own column.
- An evaluator that throws is recorded as an evaluator error. It is neither a pass nor a fail for the candidate.
- Two runs are only compared if they used the same scenario version, dataset, time limit and evaluator versions. Otherwise `aql compare` refuses and lists the reasons.

### Run files

Runs are plain files, so they can be read, diffed and scored again without the lab:

```text
runs/<run-id>/
  manifest.json      what was executed: scenario, dataset hash, candidate, config, git commit, runtime
  dataset.jsonl      a snapshot of the cases the run used
  results.jsonl      one line per case: status, output, trace, duration
  evaluations.jsonl  one line per case and evaluator: the verdict and its reason
```

Execution and scoring are separate steps. A stored run can be scored again with fixed or new evaluators without running the candidate again.

## Running a comparison

Requires Node.js 24 or later. There is no build step.

```bash
npm install
```

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

## The scenarios

| Scenario | The task | What it stresses |
|---|---|---|
| `stock-check` | Can an order for some units of an item be fulfilled? One lookup tool. 12 cases | Every way a case can end, abstaining, a tool that fails, guessing |
| `travel-cancellation` | What does it cost to cancel this booking? Six lookup tools, four of them needed. 20 cases | Policy rules, time zones, a source that should not be trusted, records that contradict each other, escalating to a human |

In `travel-cancellation` every case has its own small world of made-up records, and its own things that go wrong. It separates two ways of not answering: abstaining when the facts cannot be obtained, and escalating when the records were obtained but contradict each other. An escalation is an ordinary answer that this scenario defines; the lab itself only knows answers and abstentions.

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
| Correctness: pass | 12/12 | 6/12 |
| Tool use: pass | 12/12 | 5/12 |
| Tool calls | 15 (4 failed) | 11 (3 failed) |

Below the totals, the comparison breaks the counts down by tag and lists the cases behind every difference:

```text
tag             cases  completed A · B  correctness pass A · B  tool-use pass A · B
boundary        5      5/5 · 4/5        5/5 · 3/5               5/5 · 3/5
should-abstain  3      3/3 · 2/3        3/3 · 1/3               3/3 · 1/3
tool-failure    3      3/3 · 3/3        3/3 · 1/3               3/3 · 0/3

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

`rules` follows the task's rules step by step. `naive` makes four typical mistakes: it reads check-in times as UTC, believes the property's own description, never escalates, and gives up after one failed lookup.

| | rules | naive |
|---|---:|---:|
| Completed | 20/20 | 20/20 |
| Outcome: pass | 20/20 | 17/20 |
| Amount: pass | 14/14 | 9/14 |
| Evidence: pass | 20/20 | 19/20 |
| Tool use: pass | 20/20 | 20/20 |

The amount check applies to the 14 cases where a fee is due. The totals say that `naive` gets 7 of the 20 cases wrong in some way; the breakdown by tag, abridged here, says where:

```text
tag                  cases  outcome pass A · B  amount pass A · B
boundary             2      2/2 · 2/2           2/2 · 2/2
time-zone            2      2/2 · 2/2           2/2 · 0/2
conflicting-content  2      2/2 · 2/2           2/2 · 0/2
should-escalate      2      2/2 · 0/2           n/a
should-abstain       4      4/4 · 4/4           n/a
...
```

It gets every time-zone case and every case with a misleading property page wrong, never escalates, and handles the deadline boundaries and the abstentions correctly.

Both examples are reproducible: all four candidates are deterministic, so every run gives the same statuses, outputs and verdicts. Durations differ from run to run.

## What this evidence does and does not support

All four candidates are synthetic programs. In `stock-check`, `baseline` is a short program and `mock-agent` has no model behind it: it is a stand-in with seeded faults, built so that a single run exercises every way a case can end. The token counts it reports are made up. In `travel-cancellation`, `naive` was written to make four chosen mistakes.

The example supports these statements:

- The lab keeps completed, malformed, errored and timed-out cases apart, and counts the last three against the candidate.
- A right answer reached by guessing is caught by an evaluator that reads the trace, where a check of the final answer passes it.
- A second task from a different domain fits without any of its vocabulary in the lab's core.
- A weakness confined to one kind of case stays visible in the breakdown by tag, where the totals blur it.
- Every count in a summary or comparison can be traced to the cases behind it.

It does not support these:

- Anything about a real model, agent or framework. None has been run through the lab.
- That the mock agent's failure rates, or the naive candidate's mistakes, resemble any real system.
- That the abstractions fit very different agents. Two scenarios have exercised them, both with plain programs as candidates.
- That an explanation is any good. `travel-cancellation` records the explanation each answer gives and no check judges it.
- Anything about latency or cost. The durations are those of local function calls.

## Known limitations

Scope:

- There are two synthetic scenarios, and no adapter for a model provider or an agent framework. A candidate is a TypeScript module in the scenario's directory.

Measurement:

- A comparison uses one run per side. There are no repeated trials and no estimate of run-to-run noise, which is why a comparison describes differences and calls none of them a regression.
- The lab sees only what goes through its own tools. A candidate's own tool calls, model calls and fallbacks appear only if the candidate reports them. A silent fallback inside an opaque candidate cannot be detected.
- Token counts are whatever the candidate reports, and there is no cost estimate.
- Durations are wall-clock time on the machine that ran the lab, summarised as median and maximum.
- Versions of scenarios, candidates and evaluators are strings their authors declare. The lab records them with the dataset hash and the git commit, but cannot check that a version was changed when behaviour changed.
- Evaluators are deterministic code. There is no human review and no model-based judging.
- An evaluator cannot judge the trace of a case that did not complete.

Engineering:

- Cases run one at a time and results are written when the run finishes, so a crash during a run loses its results.
- A candidate that exceeds the time limit is signalled to stop, not killed.
- `aql eval` replaces all of a run's evaluations.
- A candidate's configuration cannot be changed from the command line.
- The run format is at version 1 and may change.
- Runs and HTML reports contain the dataset's inputs and expected values. Keep that in mind before publishing them for a held-out set.

## Adding a scenario or a candidate

The CLI finds scenarios and candidates by location:

```text
scenarios/<scenario>/
  scenario.ts          default-exports the scenario; its id must match the directory name
  datasets/*.jsonl     one case per line: id, input, and optionally expected, setup and tags
  candidates/<name>.ts default-exports a candidate
```

Tags are free labels on a case, such as `boundary` or `tool-failure`. Summaries, comparisons and the HTML report repeat every count per tag, so a weakness on one kind of case stays visible.

A case can carry a `setup`: the facts of that one case, such as what a lookup returns or which service is down. The scenario builds the case's tools from it and evaluators can read it, but the candidate never receives it. `travel-cancellation` uses one for every case; in `stock-check` the tools behave the same way for every case.

[scenarios/stock-check](scenarios/stock-check) is the smallest complete example. [scenarios/travel-cancellation](scenarios/travel-cancellation) shows a setup per case, and [scenarios/travel-shared](scenarios/travel-shared) holds the made-up marketplace that further travel scenarios can reuse. The contracts a scenario and a candidate implement are in [packages/core/src/types.ts](packages/core/src/types.ts), and the format of the run files is in [packages/core/src/artifact.ts](packages/core/src/artifact.ts).

## Repository layout

```text
packages/core   run format, runner, evaluation, summaries and comparison. No dependency on the CLI
packages/cli    the aql command and the text and HTML rendering
scenarios       scenarios with their datasets and candidates
runs            written by aql run; ignored by git
```

Core returns plain data and the CLI only formats it, so another interface can read the same run files and call the same functions.

## Development

```bash
npm test
npm run typecheck
```
