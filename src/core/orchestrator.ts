import type {
  Agent,
  AgentOutput,
  AgentStepResult,
  HarnessRequest,
  HarnessResult,
  Pipeline,
  PipelineStep,
  SharedContext,
} from "./types.js";
import type { ComplexityPlan } from "./complexity.js";
import { loadDesignSystem } from "../utils/design-system.js";

/**
 * The Orchestrator is the central coordinator. It:
 * 1. Accepts a HarnessRequest from any entry point
 * 2. Resolves a Pipeline (which agents to run and in what order)
 * 3. Executes agents phase-by-phase, accumulating artifacts
 * 4. Returns the final HarnessResult
 *
 * It does NOT know how to plan a pipeline from scratch — that's
 * delegated to a PipelinePlanner (which could itself be an LLM call,
 * or a static config, or a rule engine).
 */
export class Orchestrator {
  private agents = new Map<string, Agent>();
  private planner: PipelinePlanner;

  constructor(planner: PipelinePlanner) {
    this.planner = planner;
  }

  /** Register an agent so the orchestrator can dispatch to it */
  register(agent: Agent): this {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent "${agent.name}" is already registered`);
    }
    this.agents.set(agent.name, agent);
    return this;
  }

  /** Unregister an agent */
  unregister(name: string): this {
    this.agents.delete(name);
    return this;
  }

  /** List all registered agent names */
  listAgents(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Run the full pipeline for a request.
   * This is the single method every entry point calls.
   */
  async run(request: HarnessRequest): Promise<HarnessResult> {
    const startTime = Date.now();

    // 1. Build initial context
    const ctx: SharedContext = {
      request,
      artifacts: {},
      data: {},
    };

    // 2. Plan the pipeline
    request.onProgress?.({ type: "status", message: "Analyzing request..." });
    const planResult = await this.planner.plan(request, this.listAgents());
    const { pipeline, dynamicAgents, complexity } = planResult;

    // Register dynamic agents (e.g. per-page renderers)
    const dynamicNames: string[] = [];
    if (dynamicAgents) {
      for (const agent of dynamicAgents) {
        if (!this.agents.has(agent.name)) {
          this.agents.set(agent.name, agent);
          dynamicNames.push(agent.name);
        }
      }
    }

    // Store complexity plan in context for agents to read
    if (complexity) {
      ctx.complexity = complexity;
    }

    // Emit complexity status
    if (complexity) {
      const pageSummaries = complexity.pages.map((p) => ({ id: p.id, title: p.title, description: p.description, isLanding: p.isLanding }));
      if (complexity.tier === "multi") {
        const tree = complexity.pages.map((p) => `  ${p.isLanding ? "* " : "  "}${p.title} (${p.id})`).join("\n");
        request.onProgress?.({
          type: "status",
          message: `${complexity.pages.length} pages detected\n${tree}`,
          detail: { kind: "complexity", tier: "multi", pages: pageSummaries },
        });
      } else {
        request.onProgress?.({
          type: "status",
          message: `Single page: ${complexity.pages[0]?.title ?? "Main"}`,
          detail: { kind: "complexity", tier: "single", pages: pageSummaries },
        });
      }
    }

    request.onProgress?.({ type: "pipeline_start", pipeline });

    // Emit pipeline plan summary
    const phases = this.groupByPhase(pipeline.steps);
    const phaseSummary = [...phases.entries()].map(([phase, steps]) => ({
      phase,
      agents: steps.map((s) => s.agentName),
    }));
    const planDesc = phaseSummary
      .map((p) => `Phase ${p.phase}: ${p.agents.join(", ")}`)
      .join(" → ");
    request.onProgress?.({
      type: "status",
      message: `Pipeline: ${planDesc}`,
      detail: { kind: "pipeline_plan", phases: phaseSummary },
    });

    // 3. Execute phase by phase
    const stepResults: AgentStepResult[] = [];

    for (const [phase, steps] of phases) {
      // Filter out steps whose conditions aren't met
      const activeSteps = steps.filter(
        (s) => !s.condition || s.condition(ctx)
      );

      // Emit phase start status
      const agentNames = activeSteps.map((s) => s.agentName);
      const phaseLabel = this.describePhase(agentNames, complexity);
      request.onProgress?.({
        type: "status",
        message: phaseLabel,
        detail: { kind: "phase_start", phase, agents: agentNames },
      });

      // Run all agents in this phase concurrently
      const phaseResults = await Promise.all(
        activeSteps.map((step) => this.executeStep(step, ctx, request, phase))
      );

      // Merge results into context sequentially (deterministic order)
      for (const { output, stepResult } of phaseResults) {
        ctx.artifacts[output.artifactKey] = output.artifact;
        if (output.data) {
          Object.assign(ctx.data, output.data);
        }
        stepResults.push(stepResult);
      }
    }

    // 4. Build final result
    const totalTokens = stepResults.reduce(
      (acc, s) => ({
        input: acc.input + s.tokenUsage.input,
        output: acc.output + s.tokenUsage.output,
      }),
      { input: 0, output: 0 }
    );

    // Assemble pages for multi-page runs
    let html: string;
    let pages: Record<string, string> | undefined;

    if (complexity && complexity.tier === "multi") {
      pages = {};
      const landing = complexity.pages.find((p) => p.isLanding) ?? complexity.pages[0];

      for (const page of complexity.pages) {
        const raw = ctx.artifacts[`page_${page.id}`];
        if (raw) {
          pages[page.id] = this.injectDesignTokens(raw);
        }
      }

      // Primary html is the landing page
      html = pages[landing.id] ?? this.fallbackAssemble(ctx);
    } else {
      const rawHtml = ctx.artifacts["final_html"] ?? this.fallbackAssemble(ctx);
      html = this.injectDesignTokens(rawHtml);
    }

    const result: HarnessResult = {
      id: request.id,
      html,
      pages,
      meta: {
        durationMs: Date.now() - startTime,
        agentSteps: stepResults,
        tokenUsage: totalTokens,
      },
      data: {
        ...ctx.data,
        ...(complexity ? { pageSpecs: complexity.pages } : {}),
      },
    };

    // Clean up dynamic agents so they don't leak across runs
    for (const name of dynamicNames) {
      this.agents.delete(name);
    }

    request.onProgress?.({ type: "pipeline_complete", result });
    return result;
  }

  // ── Private helpers ──────────────────────────────────────────

  private async executeStep(
    step: PipelineStep,
    ctx: SharedContext,
    request: HarnessRequest,
    phase: number
  ): Promise<{ output: AgentOutput; stepResult: AgentStepResult }> {
    const agent = this.agents.get(step.agentName);
    if (!agent) {
      throw new Error(
        `Agent "${step.agentName}" not found. Registered: ${this.listAgents().join(", ")}`
      );
    }

    request.onProgress?.({
      type: "agent_start",
      agentName: agent.name,
      phase,
    });

    // Emit a human-friendly status for this agent
    const agentStatus = this.describeAgent(agent.name, ctx.complexity);
    request.onProgress?.({
      type: "status",
      message: agentStatus,
      detail: { kind: "agent_progress", agentName: agent.name, message: agentStatus },
    });

    // Emit design tokens before any renderer starts so the client
    // can inject them into the iframe before any HTML chunks arrive
    if (agent.name === "renderer" || agent.name.startsWith("renderer_")) {
      const ds = loadDesignSystem();
      request.onProgress?.({ type: "design_tokens", css: ds.css });
    }

    const stepStart = Date.now();

    // Pass a frozen snapshot so agents can't mutate shared state
    const snapshot: SharedContext = {
      request: ctx.request,
      artifacts: { ...ctx.artifacts },
      data: { ...ctx.data },
    };

    let output!: AgentOutput;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        output = await agent.execute(snapshot, request);
        break;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        const isRetryable = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|timeout|overloaded|premature close|socket hang up|EPIPE/i.test(errorMsg);

        if (isRetryable && attempt < maxRetries) {
          const delay = 1000 * (attempt + 1);
          request.onProgress?.({
            type: "error",
            agentName: agent.name,
            error: `${errorMsg} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        request.onProgress?.({
          type: "error",
          agentName: agent.name,
          error: errorMsg,
        });
        throw new Error(`Agent "${agent.name}" failed: ${errorMsg}`);
      }
    }

    const stepResult: AgentStepResult = {
      agentName: agent.name,
      artifactKey: output.artifactKey,
      durationMs: Date.now() - stepStart,
      tokenUsage: output.tokenUsage ?? { input: 0, output: 0 },
    };

    const doneMsg = `${this.describeAgent(agent.name, ctx.complexity)} — done in ${(stepResult.durationMs / 1000).toFixed(1)}s`;
    request.onProgress?.({
      type: "status",
      message: doneMsg,
      detail: { kind: "agent_progress", agentName: agent.name, message: doneMsg },
    });

    request.onProgress?.({ type: "agent_complete", agentName: agent.name, result: stepResult });
    request.onProgress?.({
      type: "agent_artifact",
      agentName: agent.name,
      artifactKey: output.artifactKey,
      artifact: output.artifact,
    });

    return { output, stepResult };
  }

  /** Human-friendly description of a phase based on its agents */
  private describePhase(agentNames: string[], complexity?: ComplexityPlan): string {
    if (agentNames.length === 1) {
      return this.describeAgent(agentNames[0], complexity);
    }

    // Categorize agents in this phase
    const renderers = agentNames.filter((n) => n.startsWith("renderer"));
    const validators = agentNames.filter((n) => n.startsWith("validator"));

    if (renderers.length > 1) {
      return `Rendering ${renderers.length} pages in parallel`;
    }
    if (validators.length > 1) {
      return `Validating ${validators.length} pages in parallel`;
    }

    // Mixed phase — list what's happening
    const descriptions = agentNames.map((n) => this.describeAgent(n, complexity));
    return descriptions.join(" + ");
  }

  /** Human-friendly description for a single agent */
  private describeAgent(agentName: string, complexity?: ComplexityPlan): string {
    if (agentName === "architect") return "Designing page structure and content";
    if (agentName === "shell") return "Building shared navigation and layout shell";

    // Page-specific renderer: "Rendering Dashboard (dashboard)"
    const rendererMatch = agentName.match(/^renderer_(.+)$/);
    if (rendererMatch) {
      const pageId = rendererMatch[1];
      const page = complexity?.pages.find((p) => p.id === pageId);
      return page ? `Rendering ${page.title}` : `Rendering ${pageId}`;
    }

    if (agentName === "renderer") return "Rendering HTML";

    // Page-specific validator
    const validatorMatch = agentName.match(/^validator_(.+)$/);
    if (validatorMatch) {
      const pageId = validatorMatch[1];
      const page = complexity?.pages.find((p) => p.id === pageId);
      return page ? `Validating ${page.title}` : `Validating ${pageId}`;
    }

    if (agentName === "validator") return "Validating design system compliance";

    return `Running ${agentName}`;
  }

  private groupByPhase(steps: PipelineStep[]): Map<number, PipelineStep[]> {
    const map = new Map<number, PipelineStep[]>();
    for (const step of steps) {
      const group = map.get(step.phase) ?? [];
      group.push(step);
      map.set(step.phase, group);
    }
    // Sort by phase number
    return new Map([...map.entries()].sort(([a], [b]) => a - b));
  }

  /**
   * Replace the <link rel="stylesheet" href="pesto.css"> placeholder
   * with an inline <style> block containing the Pesto design tokens.
   * This keeps generated pages self-contained across all entrypoints
   * (CLI file output, API responses, iframe srcdoc) while letting
   * the renderer skip outputting ~150 lines of CSS variable declarations.
   */
  private injectDesignTokens(html: string): string {
    const ds = loadDesignSystem();
    const styleBlock = `<style id="pesto-tokens">\n${ds.css}\n</style>`;
    // Replace the link tag with the inline style block
    const replaced = html.replace(
      /<link[^>]+href=["']pesto\.css["'][^>]*\/?>/i,
      styleBlock,
    );
    // If no link tag was found (model didn't include it), inject into <head>
    if (replaced === html) {
      return html.replace(/<head([^>]*)>/i, `<head$1>\n${styleBlock}`);
    }
    return replaced;
  }

  /** If no agent produced "final_html", wrap whatever we have */
  private fallbackAssemble(ctx: SharedContext): string {
    // If the renderer didn't run, wrap the spec in a basic page
    const body = ctx.artifacts["spec"] ?? "<!-- No output produced -->";
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Generated Page</title>
</head>
<body>
<pre>${body}</pre>
</body>
</html>`;
  }
}

// ─── Pipeline planner interface ──────────────────────────────────

/**
 * The result of planning a pipeline. Includes the pipeline itself,
 * plus optional dynamic agents and complexity info for multi-page runs.
 */
export interface PlanResult {
  pipeline: Pipeline;
  /** Agents created dynamically for this run (e.g. page renderers) */
  dynamicAgents?: Agent[];
  /** Complexity plan determined during planning */
  complexity?: ComplexityPlan;
}

/**
 * Decides which agents to run and in what order.
 * Implementations can be:
 * - StaticPlanner: always returns the same pipeline
 * - LLMPlanner: asks an LLM to decide based on the prompt
 * - RulePlanner: uses heuristics / keyword matching
 */
export interface PipelinePlanner {
  plan(request: HarnessRequest, availableAgents: string[]): Promise<PlanResult>;
}
