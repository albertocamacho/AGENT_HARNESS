import type { HarnessRequest, SharedContext } from "../core/types.js";
import { BaseAgent, extractTag } from "./base.js";
import { loadDesignSystem } from "../utils/design-system.js";

export class ArchitectAgent extends BaseAgent {
  name = "architect";
  description = "Plans the UX: page structure, content strategy, visual design, and interaction patterns";
  protected artifactKey = "spec";

  protected llmOptions = {
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
  };

  async execute(ctx: SharedContext, request: HarnessRequest): Promise<import("../core/types.js").AgentOutput> {
    // Scale token budget with page count so multi-page specs aren't truncated
    const pageCount = ctx.complexity?.pages.length ?? 1;
    if (pageCount > 1) {
      this.llmOptions.maxTokens = Math.min(4096 * pageCount, 16000);
    }
    return super.execute(ctx, request);
  }

  protected get systemPrompt(): string {
    const ds = loadDesignSystem();

    return `You are a senior UX architect. Given a page brief, produce a concise
design spec a front-end developer can implement without follow-up questions.

Design within the Pesto design system. Reference Pesto tokens only.

${ds.rulesOnlyBlock}

Output your spec wrapped in <spec> tags. Be CONCISE — the renderer already
knows the design system rules, tokens, and component patterns. Focus only
on what's unique to THIS page.

Your spec has TWO sections only:

## Sections
Ordered list of every section on the page. For each:
- Section name and HTML element (header, main, section, nav, footer)
- Content: headings, body copy, CTAs (write real copy, not placeholders)
- Layout: arrangement (e.g. "3-column card grid", "sidebar + main")
- Key data: what metrics, tables, lists, or forms appear — be specific about sample content (e.g. "5-8 project rows with name, client, status, deadline, budget" not just "project table")

## Page-specific notes
Any design decisions the renderer can't infer from the design system alone:
- Custom layout patterns not covered by the standard components
- Specific data visualizations or interactive elements
- Content hierarchy choices

Rules:
- 4–6 sections per page maximum
- Write real copy — short headings, brief paragraphs, clear CTAs
- Do NOT repeat Pesto token assignments, typography rules, or component specs — the renderer already has those
- Do NOT include responsive behavior or interaction states — the renderer handles those per the design system
- Be specific about CONTENT and STRUCTURE, not about styling
- Every page must have enough content to feel populated and lived-in — specify realistic sample data, row counts, item counts, and example text`;
  }

  protected buildPrompt(ctx: SharedContext, request: HarnessRequest): string {
    const c = request.constraints;
    const complexity = ctx.complexity;

    // Multi-page: produce a spec per page
    if (complexity && complexity.tier === "multi") {
      const pageList = complexity.pages
        .map((p) => `- **${p.title}** (${p.id}): ${p.description}${p.isLanding ? " [LANDING PAGE]" : ""}`)
        .join("\n");

      let prompt = `Design UX specs for a multi-page application: "${request.prompt}"

This application has the following pages:
${pageList}

For EACH page, output a separate spec block wrapped in <spec id="PAGE_ID"> tags.
All pages must share:
- Consistent navigation bar linking to every page (use relative hrefs like "page-id.html")
- Consistent branding, color scheme, and typography
- Consistent footer (if applicable)

Each page spec must include all the standard sections (Page overview, Information architecture, Visual design, Responsive behavior, Interaction and state).`;

      if (c?.pageType) prompt += `\nPage type: ${c.pageType}`;
      if (c?.palette?.length) prompt += `\nRequired palette: ${c.palette.join(", ")}`;
      if (c?.fonts) {
        if (c.fonts.heading) prompt += `\nHeading font: ${c.fonts.heading}`;
        if (c.fonts.body) prompt += `\nBody font: ${c.fonts.body}`;
      }
      if (c?.maxSections) prompt += `\nMaximum sections per page: ${c.maxSections}`;
      if (c?.customCSS) prompt += `\nAdditional style notes:\n${c.customCSS}`;

      return prompt;
    }

    // Single-page: original behavior
    let prompt = `Design a complete UX spec for: "${request.prompt}"`;

    if (c?.pageType) prompt += `\nPage type: ${c.pageType}`;
    if (c?.palette?.length) prompt += `\nRequired palette: ${c.palette.join(", ")}`;
    if (c?.fonts) {
      if (c.fonts.heading) prompt += `\nHeading font: ${c.fonts.heading}`;
      if (c.fonts.body) prompt += `\nBody font: ${c.fonts.body}`;
    }
    if (c?.maxSections) prompt += `\nMaximum sections: ${c.maxSections}`;
    if (c?.customCSS) prompt += `\nAdditional style notes:\n${c.customCSS}`;

    return prompt;
  }

  protected parseResponse(raw: string) {
    // Check for multi-page specs: <spec id="page-id">...</spec>
    const multiSpecs = [...raw.matchAll(/<spec\s+id=["']([^"']+)["']\s*>([\s\S]*?)<\/spec>/gi)];
    if (multiSpecs.length > 1) {
      const pageSpecs: Record<string, string> = {};
      for (const match of multiSpecs) {
        pageSpecs[match[1]] = match[2].trim();
      }
      // Combine all specs into a single artifact for backward compat
      const combined = multiSpecs
        .map((m) => `## Page: ${m[1]}\n\n${m[2].trim()}`)
        .join("\n\n---\n\n");
      return {
        artifact: combined,
        data: { spec: combined, pageSpecs },
      };
    }

    // Single-page fallback
    const spec = extractTag(raw, "spec");
    return { artifact: spec, data: { spec } };
  }
}
