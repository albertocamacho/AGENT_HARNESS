import type { HarnessRequest, SharedContext } from "../core/types.js";
import { BaseAgent, extractTag } from "./base.js";
import { loadDesignSystem } from "../utils/design-system.js";

export class RendererAgent extends BaseAgent {
  name = "renderer";
  description = "Takes a UX spec and produces a complete, self-contained HTML page using the Pesto design system";
  protected artifactKey = "final_html";

  protected llmOptions = {
    maxTokens: 24000,
    model: "claude-sonnet-4-6",
    temperature: 0.5,
  };

  protected get systemPrompt(): string {
    const ds = loadDesignSystem();

    return `You are an expert front-end developer. You receive a detailed UX
specification and produce a single, self-contained HTML file that
implements it precisely, using the Pesto design system.

${ds.tokensAndRulesBlock}

Output ONLY the complete HTML document wrapped in <html_output> tags.

${ds.craftGuidelines}

Rules:
- Produce a single .html file — all CSS in a <style> tag, all JS (if any) in a <script> tag
- Load Pesto design tokens via: <link rel="stylesheet" href="pesto.css">
- Do NOT re-declare or inline the Pesto :root custom properties — they are provided by the linked stylesheet
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
- CRITICAL: populate the page with rich, realistic sample data — tables should have 5-8 rows, lists should have real items, dashboards should show charts/metrics with plausible numbers, cards should have full descriptions. An empty-looking page is a failure. Invent realistic placeholder content that fits the domain.
- Keep CSS concise — combine selectors where possible, avoid redundant declarations

${ds.referenceExample ? `Here is a reference example of a well-built Pesto page. Match this level of quality, structure, and token usage — but do NOT copy its content or layout. Use it only as a quality benchmark:

<reference_example>
${ds.referenceExample}
</reference_example>` : ""}`;
  }

  protected buildPrompt(ctx: SharedContext, request: HarnessRequest): string {
    return `Implement this UX spec as a complete HTML page.

Original brief: "${request.prompt}"

Build it as specified. IMPORTANT: Fill the page with rich, realistic sample content appropriate to the domain. Tables with real rows, lists with real items, metrics with plausible numbers, cards with full text. The page must feel lived-in and populated, never empty or skeletal.`;
  }

  protected parseResponse(raw: string) {
    // Try the expected tag pair first
    const tagged = raw.match(/<html_output>([\s\S]*?)<\/html_output>/i);
    if (tagged?.[1]?.trim()) {
      return { artifact: tagged[1].trim() };
    }

    // Strip opening <html_output> tag if present (handles truncated output)
    const stripped = raw.replace(/^[\s\S]*?<html_output>\s*/i, "").replace(/<\/html_output>[\s\S]*$/i, "");

    // Extract the HTML document
    const docMatch = stripped.match(/(<!DOCTYPE html[\s\S]*)/i);
    if (docMatch?.[1]?.trim()) {
      return { artifact: docMatch[1].trim() };
    }

    // Last resort
    return { artifact: stripped.trim() || raw.trim() };
  }
}
