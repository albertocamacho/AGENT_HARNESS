import type { HarnessRequest, SharedContext } from "../core/types.js";
import { BaseAgent, extractTag } from "./base.js";
import { loadDesignSystem } from "../utils/design-system.js";

export class ArchitectAgent extends BaseAgent {
  name = "architect";
  description = "Plans the UX: page structure, content strategy, visual design, and interaction patterns";
  protected artifactKey = "spec";

  protected llmOptions = {
    model: "claude-haiku-4-5-20251001",
  };

  protected get systemPrompt(): string {
    const ds = loadDesignSystem();

    return `You are a senior UX architect. Given a page brief, you produce a
detailed design specification that a front-end developer could implement
without asking any follow-up questions.

You MUST design within the constraints of the Pesto design system below.
All colors, spacing, typography, and component patterns must reference
Pesto tokens. Do not invent values outside the system.

${ds.rulesOnlyBlock}

Output your spec wrapped in <spec> tags as structured markdown.

Your spec MUST include all of these sections:

## Page overview
One paragraph summarizing the page's purpose, audience, and key goal.

## Information architecture
Ordered list of every section on the page. For each section:
- Section name and semantic HTML element (header, main, section, footer, etc.)
- Content: exact headings, body copy, CTAs, image descriptions
- Layout: how elements are arranged (e.g. "two-column grid, image left, text right")

## Visual design
- Reference the specific Pesto tokens to use for each role (e.g. "--pesto-brand-600 for primary buttons")
- Typography: which --pesto-text-* and --pesto-weight-* tokens for each level
- Spacing: which --pesto-space-* tokens for section gaps, card padding, etc.
- Surface treatments: which --pesto-radius-* and --pesto-shadow-* tokens

## Responsive behavior
How the layout adapts at the Pesto breakpoints (640px, 768px, 1024px, 1280px).

## Interaction and state
Hover effects using --pesto-duration-* and --pesto-ease-*, focus styles, scroll behavior.

Rules:
- Be extremely specific — a developer should never have to guess
- Write real copy, not placeholder text
- ALWAYS reference Pesto tokens by name, never raw values
- If the user gave constraints (palette, fonts, page type), honor them but express them through Pesto tokens where possible
- The spec is the ONLY input the renderer will have, so leave nothing ambiguous
- Aim for 5–8 sections maximum. Favor simplicity and impact over exhaustive detail
- Keep copy concise — short headings, brief paragraphs, clear CTAs`;
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
