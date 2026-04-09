import type { HarnessRequest, SharedContext } from "../core/types.js";
import type { PageSpec } from "../core/complexity.js";
import { BaseAgent, extractTag } from "./base.js";
import { loadDesignSystem } from "../utils/design-system.js";

/**
 * Renders a single page within a multi-page app.
 * One instance is created per page in the ComplexityPlan,
 * and all run in parallel during the same phase.
 */
export class PageRendererAgent extends BaseAgent {
  name: string;
  description: string;
  protected artifactKey: string;

  protected llmOptions = {
    maxTokens: 24000,
    model: "claude-sonnet-4-6",
    temperature: 0.5,
  };

  private page: PageSpec;
  private allPages: PageSpec[];

  constructor(page: PageSpec, allPages: PageSpec[]) {
    super();
    this.page = page;
    this.allPages = allPages;
    this.name = `renderer_${page.id}`;
    this.description = `Renders the "${page.title}" page`;
    this.artifactKey = `page_${page.id}`;
  }

  protected get systemPrompt(): string {
    const ds = loadDesignSystem();

    return `You are an expert front-end developer. You receive a detailed UX
specification and a shared UI shell (nav, footer, CSS), and produce a
single, self-contained HTML page using the Pesto design system.

This page is part of a multi-page application. A shared shell has already
been generated for you — you MUST include its nav, footer, and CSS
EXACTLY as provided. Do not modify, restyle, or regenerate them.

Current page: "${this.page.title}" (${this.page.id}.html)
To mark this page as active in the navigation, add the class "active" to
the nav link with data-page="${this.page.id}".

${ds.tokensAndRulesBlock}

Output ONLY the complete HTML document wrapped in <html_output> tags.

${ds.craftGuidelines}

Rules:
- Produce a single .html file — all CSS in a <style> tag, all JS (if any) in a <script> tag
- Load Pesto design tokens via: <link rel="stylesheet" href="pesto.css">
- Do NOT re-declare or inline the Pesto :root custom properties — they are provided by the linked stylesheet
- Include the shell CSS verbatim in your <style> block, then add page-specific styles after it
- Include the shell nav HTML verbatim at the top of <body>, before <main>
- Include the shell footer HTML verbatim at the bottom of <body>, after </main>
- Only generate the <main> content and page-specific CSS — do NOT regenerate nav or footer
- ALL colors, spacing, typography, radii, and shadows MUST use var(--pesto-*) tokens
- Follow every rule in the component rules above — buttons, cards, forms, nav, badges, etc.
- Follow the spec exactly: copy, layout, responsive behavior
- Use semantic HTML5 elements
- Use modern CSS: custom properties, grid, flexbox, clamp()
- Mobile-first responsive design using the Pesto breakpoints (640px, 768px, 1024px, 1280px)
- Ensure WCAG AA contrast on all text
- Add smooth transitions using --pesto-duration-* and --pesto-ease-* tokens
- Import Inter from Google Fonts via <link> tag
- Images: use <img> with descriptive alt text and src="https://placehold.co/WxH"
- The page must look polished and production-ready
- Do NOT use inline styles, !important, hardcoded colors, or CSS frameworks
- CRITICAL: populate every page with rich, realistic sample data — tables should have 5-8 rows, lists should have real items, dashboards should show charts/metrics with plausible numbers, cards should have full descriptions. An empty-looking page is a failure. Invent realistic placeholder content that fits the domain.
- Keep CSS concise — combine selectors where possible, avoid redundant declarations

${ds.referenceExample ? `Here is a reference example of a well-built Pesto page. Match this level of quality, structure, and token usage — but do NOT copy its content or layout. Use it only as a quality benchmark:

<reference_example>
${ds.referenceExample}
</reference_example>` : ""}`;
  }

  protected buildPrompt(ctx: SharedContext, request: HarnessRequest): string {
    // Parse the shared shell artifact if available
    let shellBlock = "";
    const shellRaw = ctx.artifacts["shared_shell"];
    if (shellRaw) {
      try {
        const shell = JSON.parse(shellRaw);
        shellBlock = `
Here is the shared UI shell. Include these EXACTLY as-is in your output:

<shared_nav>
${shell.navHtml}
</shared_nav>

<shared_footer>
${shell.footerHtml}
</shared_footer>

<shared_css>
${shell.shellCss}
</shared_css>

Remember: add class="active" to the link with data-page="${this.page.id}" in the nav.`;
      } catch { /* fall through without shell */ }
    }

    return `Implement the "${this.page.title}" page as a complete HTML page.

Page description: ${this.page.description}

Original brief: "${request.prompt}"
${shellBlock}

Build it as specified. This is the "${this.page.id}" page of a multi-page application.
IMPORTANT: Fill the page with rich, realistic sample content appropriate to the domain. Tables with real rows, lists with real items, metrics with plausible numbers, cards with full text. The page must feel lived-in and populated, never empty or skeletal.`;
  }

  protected parseResponse(raw: string) {
    const tagged = raw.match(/<html_output>([\s\S]*?)<\/html_output>/i);
    if (tagged?.[1]?.trim()) {
      return { artifact: tagged[1].trim() };
    }

    const stripped = raw
      .replace(/^[\s\S]*?<html_output>\s*/i, "")
      .replace(/<\/html_output>[\s\S]*$/i, "");

    const docMatch = stripped.match(/(<!DOCTYPE html[\s\S]*)/i);
    if (docMatch?.[1]?.trim()) {
      return { artifact: docMatch[1].trim() };
    }

    return { artifact: stripped.trim() || raw.trim() };
  }
}
