import { Orchestrator } from "./orchestrator.js";
import { StaticPlanner, LLMPlanner } from "./planners.js";
import { createDefaultAgents } from "../agents/index.js";
import type { Agent } from "./types.js";

export interface HarnessConfig {
  /** Use LLM to dynamically plan pipelines, or static default */
  planner?: "static" | "llm";
  /** Additional agents beyond the defaults */
  extraAgents?: Agent[];
  /** Replace default agents entirely */
  agents?: Agent[];
}

/**
 * Create a fully configured Orchestrator ready to accept requests.
 * This is the main entry point for programmatic usage.
 */
export function createHarness(config: HarnessConfig = {}): Orchestrator {
  const planner =
    config.planner === "llm" ? new LLMPlanner() : new StaticPlanner();

  const orchestrator = new Orchestrator(planner);

  const agents = config.agents ?? createDefaultAgents();
  for (const agent of agents) {
    orchestrator.register(agent);
  }

  if (config.extraAgents) {
    for (const agent of config.extraAgents) {
      orchestrator.register(agent);
    }
  }

  return orchestrator;
}
