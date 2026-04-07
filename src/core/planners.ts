import type { HarnessRequest, Pipeline } from "./types.js";
import type { PipelinePlanner, PlanResult } from "./orchestrator.js";
import { llmCall } from "../utils/llm.js";
import { detectComplexity } from "./complexity.js";
import { PageRendererAgent } from "../agents/page-renderer.js";
import { ShellRendererAgent } from "../agents/shell-renderer.js";
import { ValidatorAgent } from "../agents/validator.js";

/**
 * Always runs: architect → renderer → validator.
 * For multi-page requests, detects complexity and spawns parallel page renderers.
 */
export class StaticPlanner implements PipelinePlanner {
  async plan(request: HarnessRequest, _available: string[]): Promise<PlanResult> {
    const complexity = await detectComplexity(request.prompt, request.constraints);

    if (complexity.tier === "multi") {
      // Shell renderer generates shared nav/footer/CSS once
      const shellRenderer = new ShellRendererAgent(complexity.pages);

      // Create a page-renderer agent per page, all in the same phase
      const pageRenderers = complexity.pages.map(
        (page) => new PageRendererAgent(page, complexity.pages),
      );

      // Create a validator per page, targeting each page's artifact
      const pageValidators = complexity.pages.map(
        (page) => new ValidatorAgent(`page_${page.id}`, `validator_${page.id}`),
      );

      const dynamicAgents = [shellRenderer, ...pageRenderers, ...pageValidators];

      const steps: Pipeline["steps"] = [
        { agentName: "architect", phase: 0 },
        { agentName: "shell", phase: 1 },
        ...complexity.pages.map((page) => ({
          agentName: `renderer_${page.id}`,
          phase: 2,
        })),
        ...complexity.pages.map((page) => ({
          agentName: `validator_${page.id}`,
          phase: 3,
          condition: (ctx: import("./types.js").SharedContext) => !ctx.request.skipValidation,
        })),
      ];

      return {
        pipeline: { steps },
        dynamicAgents,
        complexity,
      };
    }

    // Single-page: original behavior
    return {
      pipeline: {
        steps: [
          { agentName: "architect", phase: 0 },
          { agentName: "renderer", phase: 1 },
          {
            agentName: "validator",
            phase: 2,
            condition: (ctx) => !ctx.request.skipValidation,
          },
        ],
      },
      complexity,
    };
  }
}

/**
 * Asks an LLM to decide the pipeline based on the prompt.
 * Can dynamically skip agents or reorder phases.
 * For multi-page requests, also integrates complexity detection.
 */
export class LLMPlanner implements PipelinePlanner {
  async plan(request: HarnessRequest, available: string[]): Promise<PlanResult> {
    // Detect complexity first
    const complexity = await detectComplexity(request.prompt, request.constraints);

    // For multi-page, delegate to StaticPlanner's multi-page logic
    // (the LLM planner doesn't know about dynamic page agents)
    if (complexity.tier === "multi") {
      const staticResult = await new StaticPlanner().plan(request, available);
      return { ...staticResult, complexity };
    }

    // Single-page: use LLM to decide pipeline
    const systemPrompt = `You are a pipeline planner for an HTML page generation system.
Given a user's page description and the list of available agents, decide:
1. Which agents to use
2. What phase (execution order) each should run in
3. Agents in the same phase run concurrently

Available agents: ${available.join(", ")}

Respond with ONLY valid JSON matching this schema:
{
  "steps": [
    { "agentName": "string", "phase": number }
  ]
}

Rules:
- Phase numbers start at 0
- "validator" should always be last — it enforces design system compliance
- Agents that don't depend on each other can share a phase
- Only use agents from the available list`;

    const response = await llmCall({
      system: systemPrompt,
      prompt: `Plan a pipeline for: "${request.prompt}"`,
      maxTokens: 500,
    });

    try {
      const parsed = JSON.parse(response);
      return { pipeline: parsed as Pipeline, complexity };
    } catch {
      // Fall back to static if LLM gives bad JSON
      console.warn("LLM planner returned invalid JSON, falling back to static plan");
      return new StaticPlanner().plan(request, available);
    }
  }
}
