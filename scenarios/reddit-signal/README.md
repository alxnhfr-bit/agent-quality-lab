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
| Camunda, first run | v2.1 | 78/91 (85.7%) | 62/74 |
| Camunda, re-run | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm A, run 1 | v2.1 | 81/91 (89.0%) | 64/74 |
| MCP arm A, run 2 | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm A, run 3 | v2.1 | 80/91 (87.9%) | 63/74 |
| MCP arm B | v2.1 | 79/91 (86.8%) | 62/74 |
| MCP arm C | v2.1 | 78/91 (85.7%) | 61/74 |

The agent's per-label precision and recall, and its table of which label was mistaken for which, match its own report as well. The agent's run from before the rubric rewrite cannot be reproduced: its answers were never stored in the project.

Three MCP runs on 31 of the posts are not imported, since a run has to cover every case of its dataset.

## Where the lab counts differently

The totals agree, but two things are recorded as what they were rather than mapped onto a label:

- **A label outside the five** is malformed output. The agent's own scorer counts it as `no_signal`, which can turn it into a right answer. None of the stored runs above contains one.
- **A post with no recorded label** is an error. The Camunda project's first run has two of these: its runner read the result before the engine had stored it, as the project's own friction log describes. Its report counts them as wrong answers; the lab counts them as wrong too, but as errors, so the fault in the measurement stays visible.

## Not yet

- The Camunda and MCP projects recorded their tool calls. They are not imported yet, so the lab cannot yet check that places were verified, and it shows their tool calls as "not imported", not as zero.
- Running a system live through the lab. The scenario gives no instructions of its own: each project brought its own rubric and prompt, recorded with its runs.
