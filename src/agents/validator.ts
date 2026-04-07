import type { Agent, AgentOutput, HarnessRequest, SharedContext } from "../core/types.js";

/**
 * Local-only design system validator. Runs fast regex checks and
 * applies deterministic fixes — no LLM call required.
 */
export class ValidatorAgent implements Agent {
  name: string;
  description: string;
  private artifactKey: string;

  constructor(targetArtifact = "final_html", id?: string) {
    this.artifactKey = targetArtifact;
    this.name = id ?? "validator";
    this.description = `Validates HTML (${targetArtifact}) for Pesto design system compliance`;
  }

  async execute(ctx: SharedContext, _request: HarnessRequest): Promise<AgentOutput> {
    const html = ctx.artifacts[this.artifactKey] ?? "";
    const issues = ValidatorAgent.quickCheck(html);

    if (issues.length === 0) {
      return {
        artifactKey: this.artifactKey,
        artifact: html,
        data: {
          audit: "No violations found.",
          violationCount: 0,
          passed: true,
        },
        tokenUsage: { input: 0, output: 0 },
      };
    }

    // Apply deterministic fixes
    const { fixed, fixesApplied } = ValidatorAgent.quickFix(html, issues);

    const audit = issues
      .map((issue, i) => `- ${issue}${i < fixesApplied.length ? ` → fixed: ${fixesApplied[i]}` : ""}`)
      .join("\n");

    return {
      artifactKey: this.artifactKey,
      artifact: fixed,
      data: {
        audit,
        violationCount: issues.length,
        fixCount: fixesApplied.length,
        passed: false,
      },
      tokenUsage: { input: 0, output: 0 },
    };
  }

  /**
   * Fast local regex checks for common Pesto violations.
   * Returns a list of issue descriptions. Empty = likely compliant.
   */
  static quickCheck(html: string): string[] {
    const issues: string[] = [];

    // Split out the :root block so we don't flag custom property definitions
    const rootBlockRegex = /:root\s*\{[^}]*\}/gs;
    const cssWithoutRoot = html.replace(rootBlockRegex, "");

    // 1. Inline styles
    if (/\sstyle\s*=/i.test(html)) {
      issues.push("Inline style attribute found");
    }

    // 2. !important
    if (/!important/i.test(html)) {
      issues.push("!important declaration found");
    }

    // 3. Hardcoded hex colors in CSS (outside :root)
    const hexInCSS = cssWithoutRoot.match(/(?:color|background|border|shadow|outline)\s*:[^;]*#[0-9a-fA-F]{3,8}/g);
    if (hexInCSS && hexInCSS.length > 0) {
      issues.push(`Hardcoded hex color(s) in CSS: ${hexInCSS.length} occurrence(s)`);
    }

    // 4. Hardcoded font-size with px/rem (outside :root)
    const hardcodedFontSize = cssWithoutRoot.match(/font-size\s*:\s*[\d.]+(?:px|rem)\b/g);
    if (hardcodedFontSize && hardcodedFontSize.length > 0) {
      issues.push(`Hardcoded font-size value(s): ${hardcodedFontSize.length} occurrence(s)`);
    }

    // 5. <br> tags (spacing abuse)
    if (/<br\s*\/?>/gi.test(html)) {
      issues.push("<br> tag found (likely used for spacing)");
    }

    // 6. Skipped heading levels
    const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => parseInt(m[1]));
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        issues.push(`Skipped heading level: h${headings[i - 1]} → h${headings[i]}`);
        break;
      }
    }

    // 7. Images missing alt attribute
    const imgsWithoutAlt = html.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi);
    if (imgsWithoutAlt && imgsWithoutAlt.length > 0) {
      issues.push(`Image(s) missing alt attribute: ${imgsWithoutAlt.length}`);
    }

    // 8. Inputs missing associated labels
    const inputs = html.match(/<input\b[^>]*>/gi) || [];
    const labels = html.match(/<label\b[^>]*>/gi) || [];
    if (inputs.length > 0 && labels.length < inputs.length) {
      issues.push(`Input(s) likely missing labels: ${inputs.length} inputs, ${labels.length} labels`);
    }

    // 9. Focus styles explicitly removed (outline: none without replacement)
    if (/:(focus|focus-visible)\s*\{[^}]*outline\s*:\s*none/gi.test(html)) {
      issues.push("Focus outline explicitly removed");
    }

    return issues;
  }

  /**
   * Apply deterministic fixes for issues that have clear mechanical solutions.
   * Returns the fixed HTML and a list of descriptions of what was fixed.
   */
  static quickFix(html: string, issues: string[]): { fixed: string; fixesApplied: string[] } {
    let fixed = html;
    const fixesApplied: string[] = [];

    for (const issue of issues) {
      if (issue === "Inline style attribute found") {
        // Strip inline style attributes
        const before = fixed;
        fixed = fixed.replace(/\s+style="[^"]*"/gi, "");
        fixed = fixed.replace(/\s+style='[^']*'/gi, "");
        if (fixed !== before) fixesApplied.push("Removed inline style attributes");
      }

      if (issue === "!important declaration found") {
        const before = fixed;
        fixed = fixed.replace(/\s*!important/gi, "");
        if (fixed !== before) fixesApplied.push("Removed !important declarations");
      }

      if (issue.startsWith("<br> tag found")) {
        const before = fixed;
        fixed = fixed.replace(/<br\s*\/?>/gi, "");
        if (fixed !== before) fixesApplied.push("Removed <br> tags");
      }

      if (issue.startsWith("Image(s) missing alt")) {
        const before = fixed;
        fixed = fixed.replace(/<img\b(?![^>]*\balt\s*=)([^>]*)>/gi, '<img$1 alt="">');
        if (fixed !== before) fixesApplied.push("Added empty alt attributes to images");
      }

      if (issue === "Focus outline explicitly removed") {
        const before = fixed;
        fixed = fixed.replace(
          /(:(?:focus|focus-visible)\s*\{[^}]*)outline\s*:\s*none\s*;?/gi,
          "$1outline: 2px solid var(--pesto-border-focus); outline-offset: 2px;",
        );
        if (fixed !== before) fixesApplied.push("Replaced outline:none with Pesto focus style");
      }
    }

    return { fixed, fixesApplied };
  }
}
