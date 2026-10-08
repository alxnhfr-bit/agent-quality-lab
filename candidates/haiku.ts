/** A small Claude model, given the scenario's instructions and tools. Costs money to run. */
import { modelCandidate } from "@agent-quality-lab/models";
import { ANTHROPIC_PRICES, anthropic } from "@agent-quality-lab/models/anthropic";

export default modelCandidate({
  id: "haiku",
  client: anthropic({ model: "claude-haiku-4-5" }),
  prices: ANTHROPIC_PRICES,
});
