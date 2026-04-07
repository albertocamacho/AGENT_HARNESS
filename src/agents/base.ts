import type { Agent, AgentOutput, HarnessRequest, SharedContext } from "../core/types.js";
import { llmCallWithUsage, type LLMCallOptions } from "../utils/llm.js";

/**
 * Base class for LLM-powered agents. Provides:
 * - Consistent system prompt structure
 * - Context injection (prior artifacts)
 * - Token tracking
 *
 * Subclasses override `buildPrompt()` and `parseResponse()`.
 */
export abstract class BaseAgent implements Agent {
  abstract name: string;
  abstract description: string;

  /** The system prompt for this agent's specialization */
  protected abstract systemPrompt: string;

  /** Build the user-facing prompt, given context */
  protected abstract buildPrompt(ctx: SharedContext, request: HarnessRequest): string;

  /** Extract the artifact from the LLM's raw text response */
  protected abstract parseResponse(raw: string): { artifact: string; data?: Record<string, unknown> };

  /** The artifact key this agent writes to */
  protected abstract artifactKey: string;

  /** Optional: override model, temperature, etc. */
  protected llmOptions: Partial<LLMCallOptions> = {};

  async execute(ctx: SharedContext, request: HarnessRequest): Promise<AgentOutput> {
    const prompt = this.buildPrompt(ctx, request);

    // Inject available context from previous agents
    const contextBlock = this.formatContext(ctx);
    const fullPrompt = contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;

    const result = await llmCallWithUsage({
      system: this.systemPrompt,
      prompt: fullPrompt,
      ...this.llmOptions,
      onChunk: request.onProgress
        ? (chunk) => request.onProgress!({ type: "agent_chunk", agentName: this.name, chunk })
        : undefined,
    });

    const parsed = this.parseResponse(result.text);

    return {
      artifactKey: this.artifactKey,
      artifact: parsed.artifact,
      data: parsed.data,
      tokenUsage: result.usage,
    };
  }

  /** Format prior artifacts into a context block the LLM can reference */
  private formatContext(ctx: SharedContext): string {
    const entries = Object.entries(ctx.artifacts);
    if (entries.length === 0) return "";

    const blocks = entries.map(
      ([key, value]) => `<prior_artifact key="${key}">\n${value}\n</prior_artifact>`
    );

    return `Here are the artifacts produced by earlier agents:\n\n${blocks.join("\n\n")}`;
  }
}

/**
 * Helper to extract content between XML-style tags from LLM output.
 * e.g. extractTag(text, "html") pulls content from <html>...</html>
 */
export function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? text.trim();
}
