/** A mid-sized Claude model, given the scenario's instructions and tools. Costs money to run. */
import { modelCandidate } from "@agent-quality-lab/models";
import { ANTHROPIC_PRICES, anthropic } from "@agent-quality-lab/models/anthropic";

export default modelCandidate({
  id: "sonnet",
  client: anthropic({ model: "claude-sonnet-5-5", effort: "medium" }),
  prices: ANTHROPIC_PRICES,
});
