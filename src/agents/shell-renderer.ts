import type { HarnessRequest, SharedContext } from "../core/types.js";
import type { PageSpec } from "../core/complexity.js";
import { BaseAgent, extractTag } from "./base.js";
import { loadDesignSystem } from "../utils/design-system.js";

/**
 * Generates the shared UI shell (nav, footer, base layout CSS) for
 * multi-page applications. Runs once between the architect and page
 * renderers so every page uses identical shared components.
 */
export class ShellRendererAgent extends BaseAgent {
  name = "shell";
  description = "Generates the shared navigation, footer, and base layout CSS for a multi-page app";
  protected artifactKey = "shared_shell";

  protected llmOptions = {
    maxTokens: 6000,
    model: "claude-sonnet-4-6",
  };

  private pages: PageSpec[];

  constructor(pages: PageSpec[]) {
    super();
    this.pages = pages;
  }

  protected get systemPrompt(): string {
    const ds = loadDesignSystem();

    const navLinks = this.pages
      .map((p) => `- ${p.title} → ${p.id}.html${p.isLanding ? " (landing)" : ""}`)
      .join("\n");

    return `You are an expert front-end developer. You generate ONLY the shared UI
components for a multi-page application — the navigation bar, page header,
footer, and base layout CSS. These will be included verbatim in every page.

Pages in this application:
${navLinks}

${ds.tokensAndRulesBlock}

Output your shared shell wrapped in <shell> tags with these exact sections:

<shell>
<nav_html>
<!-- The complete <nav> element with all links. Use relative hrefs (e.g. href="dashboard.html").
     Include a data-page attribute on each link matching the page id for active state styling.
     Example: <a href="dashboard.html" data-page="dashboard">Dashboard</a> -->
</nav_html>

<page_header_html>
<!-- A reusable page header template placed at the top of <main>.
     Contains an <h1> with class="page-title" (the page renderer will replace its text content)
     and optionally a breadcrumb or subtitle with class="page-subtitle".
     This ensures every page has an identical header layout.
     Example:
     <header class="page-header">
       <div class="page-header-container">
         <h1 class="page-title">Page Title</h1>
         <p class="page-subtitle">Brief description</p>
       </div>
     </header>
-->
</page_header_html>

<footer_html>
<!-- The complete <footer> element -->
</footer_html>

<shell_css>
/* All CSS for: nav, page header, footer, base layout (container, page structure),
   responsive nav collapse, and any shared utility classes.
   Do NOT include page-specific content styles.
   The .page-header, .page-title, and .page-subtitle must be styled here. */
</shell_css>
</shell>

Rules:
- ALL colors, spacing, typography, radii, and shadows MUST use var(--pesto-*) tokens
- Nav must be sticky with proper z-index using Pesto tokens
- Nav must collapse to a hamburger menu at --pesto-container-md or below
- Include hover, focus-visible, and active states on all nav links
- The active link is styled via a CSS rule: [data-page].active or .nav-link.active
- Page header h1 must use --pesto-text-2xl and --pesto-weight-bold — never hero sizes
- Page header must use the same centered container pattern as nav and footer
- Footer uses secondary/tertiary text colors and a top border
- Use a centered container pattern: width: var(--pesto-content-width); margin-inline: auto
- Import Inter from Google Fonts via <link> tag (output the <link> tag in nav_html)
- Do NOT include <html>, <head>, <body>, or <main> tags — only the components
- Keep CSS concise — this shell will be combined with page-specific styles`;
  }

  protected buildPrompt(ctx: SharedContext, request: HarnessRequest): string {
    return `Generate the shared UI shell for this multi-page application.

Original brief: "${request.prompt}"

Read the architect's spec carefully and ensure the nav and footer match the specified design.`;
  }

  protected parseResponse(raw: string) {
    const shell = extractTag(raw, "shell");
    const navHtml = extractTag(shell, "nav_html");
    const pageHeaderHtml = extractTag(shell, "page_header_html");
    const footerHtml = extractTag(shell, "footer_html");
    const shellCss = extractTag(shell, "shell_css");

    const artifact = JSON.stringify({ navHtml, pageHeaderHtml, footerHtml, shellCss });

    return {
      artifact,
      data: { navHtml, pageHeaderHtml, footerHtml, shellCss },
    };
  }
}
