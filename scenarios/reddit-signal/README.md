# reddit-signal

Sort a Reddit travel post into exactly one of five labels, for a travel app's product research:

| Label | When |
|---|---|
| `competitor_mentions` | The post names a specific travel product or platform in a substantive way, or someone is building one |
| `feature_gaps` | The poster needs a tool or resource that does not exist, or an existing one fails a specific need |
| `rising_destinations` | Interest in a place off the standard circuit is growing |
| `planning_pain_points` | A specific person has a specific planning, booking or travel problem |
| `no_signal` | None of the above, and the most common correct answer |

This is the first scenario built around systems that already existed before the lab. Three projects measured themselves against the same 91 hand-labelled posts:

| Project | How it sorts a post |
|---|---|
| Reddit Signal Agent (private repository) | The production agent. Claude Haiku 4.5 reads the subreddit, title, scores and the first 500 characters of the post text, all posts in one request. |
| [camunda-trial](https://github.com/alxnhfr-bit/camunda-trial) | A Camunda 8 process. Claude Sonnet 5 reads the subreddit and title, one post at a time, and checks places with a tool before calling them rising. |
| [mcp-grounding](https://github.com/alxnhfr-bit/mcp-grounding) | The same, with the place check served over MCP, in three variants ("arms") of where the tool policy is written. |

17 of the 91 posts are quoted as examples in the labelling rubric, so a system that follows the rubric was told their answer. Cases carry the tag `in-rubric` or `held-out`, and the held-out figure is the one to read.

## The posts are not in this repository

They are other people's writing. `prepare.ts` reads them, and the stored answers of every full run, from the three projects on this computer into `datasets/` and `imports/` here, which git ignores:

```bash
node scenarios/reddit-signal/prepare.ts
```

It looks for the projects next to the lab's own folder; `--from <folder>` names another. Then each stored run is loaded as a lab run and scored:

```bash
for f in scenarios/reddit-signal/imports/labels-v2/*.json; do npx aql import reddit-signal "$f" --dataset labels-v2; done
```

```bash
for f in scenarios/reddit-signal/imports/labels-v2.1/*.json; do npx aql import reddit-signal "$f" --dataset labels-v2.1; done
```

Nothing is called and nothing costs anything. An imported run says that it was imported, and records no durations, since the lab did not watch it being made.

## Two label sets

The posts were labelled twice. Version 2.1, used by the Camunda and MCP projects, relabels four posts of version 2, used by the agent. The scenario keeps both as separate datasets, so the lab refuses to compare a result on one with a result on the other.

The projects also differ in model, in what the model reads and in how many posts it sees at once. A difference between the agent's figure and the Camunda figure is therefore not a difference between the two architectures.

## What the lab reproduces

Imported and scored by the lab, every full stored run arrives at the figure its own project reported:

| Run | Labels | Right label | Held out |
|---|---|---:|---:|
| Agent, rewritten prompt | v2 | 57/91 (62.6%) | 41/74 |
| Camunda, first run | v2.1 | 78/91 (85.7%), 2 without an answer | 62/74, 1 without an answer |
| Camunda, re-run | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm A, run 1 | v2.1 | 81/91 (89.0%) | 64/74 |
| MCP arm A, run 2 | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm A, run 3 | v2.1 | 80/91 (87.9%) | 63/74 |
| MCP arm B | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm C | v2.1 | 78/91 (85.7%) | 61/74 |

The table counts right answers over all posts, as the projects' reports do. The lab's own report shows Camunda's first run as 78/89 + 2 without an answer: 78 right of the 89 answers it gave, and 2 posts with no answer at all.

The agent's per-label precision and recall, and its table of which label was mistaken for which, match its own report as well. The agent's run from before the rubric rewrite cannot be reproduced: its answers were never stored in the project.

Three MCP runs on 31 of the posts are not imported, since a run has to cover every case of its dataset.

## The place check

The Camunda and MCP prompts carry a tool policy: before calling a post a rising destination, confirm with the `verify_place` tool that the place exists, and leave the tool alone otherwise. Two checks mirror the projects' own scorer:

- **`verified`**: a post labelled `rising_destinations` has a confirmed place.
- **`restraint`**: a post that should be `no_signal` gets no lookup at all.

The lookups come from what each project recorded. MCP recorded every lookup: what was asked and what came back. Camunda recorded less, how many lookups a post got and which places they confirmed, so for Camunda the lab knows each confirmed place but not the question asked. The agent had no tool, so neither check applies to it.

| Run | Verified | Restraint | Lookups on a post that should be `no_signal` |
|---|---:|---:|---|
| Camunda, first run | 7/7 + 2 without an answer | 59/60 + 2 without an answer | 1uq2v7u |
| Camunda, re-run | 7/7 | 62/62 | none |
| MCP arm A, run 1 | 8/8 | 61/62 | 1ute6a4 (Sedona) |
| MCP arm A, run 2 | 8/8 | 61/62 | 1ute6a4 (Sedona) |
| MCP arm A, run 3 | 7/7 | 61/62 | 1ute6a4 (Sedona) |
| MCP arm B | 8/8 | 61/62 | 1ute6a4 (Sedona) |
| MCP arm C | 9/9 | 60/62 | 1ute6a4 (Sedona), 1uscl07 |

Every figure matches the project's own report except one. Camunda's first run has two posts with no recorded label, described below. The lab shows them beside each count as posts without an answer, since it has no answer to judge; the project's scorer judged them as answered with no lookup. So for restraint the lab has 59 of 60 judged posts, where the project's report has 61 of 62.

A side-by-side comparison shows the lookups too: Camunda's re-run and MCP's second run differ on Sedona, where MCP looked the place up and then called the post a rising destination, and on two posts where Camunda made two lookups and MCP one.

## Repeated runs

MCP arm A was run three times, and Camunda twice. `aql overview reddit-signal --dataset labels-v2.1` shows every system with each check as a range over its runs:

| System | Runs | Right label | Verified | Restraint |
|---|---:|---:|---:|---:|
| MCP arm A | 3 | 86.8–89.0% | 100% | 98.4% |
| Camunda | 2 | 86.8–87.6% * | 100% * | 98.3–100% * |
| MCP arm B | 1 | 86.8% | 100% | 98.4% |
| MCP arm C | 1 | 85.7% | 100% | 96.8% |

\* One of Camunda's runs has two posts without an answer, so its shares are of the 89 answers it gave.

No difference between the systems can be called: only arm A ran three times with every post answered, and Camunda's figures sit inside arm A's range. The MCP project came to the same conclusion in its own write-up: moving the tool between protocols made no detectable difference to accuracy.

Across arm A's three runs, 88 posts got the same verdict every time: 79 right every time and 9 wrong every time. The 9 are systematic, a matter for the prompt or the rubric. Three posts were right in only one run of three, among them the Sedona post. They are the noise a single run cannot tell apart from the rest.

## Where the lab counts differently

The totals agree, but two things are recorded as what they were rather than mapped onto a label:

- **A label outside the five** is malformed output. The agent's own scorer counts it as `no_signal`, which can turn it into a right answer. None of the stored runs above contains one.
- **A post with no recorded label** is an error. The Camunda project's first run has two of these: its runner read the result before the engine had stored it, as the project's own friction log describes. Its report counts them as wrong answers; the lab counts them as wrong too, but as errors, so the fault in the measurement stays visible.
- **A confirmed place with no lookup counted.** In the same run, post 1uqrtb7 has a confirmed place but a lookup count of zero. The count was read from the same lagging store; a confirmed place carries an id that only a lookup returns. The lab counts it as one lookup and records the correction with the run, under `lookupCorrections`.

## Not yet

- MCP's model calls and token counts, and the projects' own timings, are not imported.
- Running a system live through the lab. The scenario gives no instructions of its own: each project brought its own rubric and prompt, recorded with its runs.
