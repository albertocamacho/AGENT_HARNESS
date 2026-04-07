import { readFileSync, readdirSync } from "fs";
import { join, extname } from "path";

export interface DesignSystem {
  /** Raw CSS with all custom properties */
  css: string;
  /** Component rules in markdown */
  rules: string;
  /** Visual craft guidelines in markdown */
  craftGuidelines: string;
  /** Reference HTML example demonstrating ideal output */
  referenceExample: string;
  /** Combined prompt-ready block for injection into agents */
  promptBlock: string;
  /** Rules only — for the architect (no CSS tokens) */
  rulesOnlyBlock: string;
  /** CSS tokens only — for the renderer (no audit checklist) */
  tokensAndRulesBlock: string;
}

let cached: DesignSystem | null = null;

/**
 * Load the design system from disk.
 * Reads all .css and .md files from the design-system directory,
 * caches the result for the lifetime of the process.
 */
export function loadDesignSystem(dir?: string): DesignSystem {
  if (cached) return cached;

  const baseDir = dir ?? findDesignSystemDir();
  const files = readdirSync(baseDir);

  const cssFiles = files.filter((f) => extname(f) === ".css");
  const mdFiles = files.filter((f) => extname(f) === ".md" && !f.startsWith("visual-craft"));
  const craftFiles = files.filter((f) => f.startsWith("visual-craft") && extname(f) === ".md");
  const htmlFiles = files.filter((f) => f.startsWith("reference-") && extname(f) === ".html");

  const css = cssFiles
    .map((f) => readFileSync(join(baseDir, f), "utf-8"))
    .join("\n\n");

  const rules = mdFiles
    .map((f) => readFileSync(join(baseDir, f), "utf-8"))
    .join("\n\n");

  const craftGuidelines = craftFiles
    .map((f) => readFileSync(join(baseDir, f), "utf-8"))
    .join("\n\n");

  const referenceExample = htmlFiles
    .map((f) => readFileSync(join(baseDir, f), "utf-8"))
    .join("\n\n");

  const promptBlock = `<design_system>
<design_tokens>
${css}
</design_tokens>

<component_rules>
${rules}
</component_rules>
</design_system>`;

  // Architect only needs the rules (token names are referenced there)
  // plus a summary of available token categories, not every CSS value
  const tokenSummary = extractTokenNames(css);
  const rulesOnlyBlock = `<design_system>
<available_tokens>
${tokenSummary}
</available_tokens>

<component_rules>
${rules}
</component_rules>
</design_system>`;

  // Renderer needs full CSS tokens + component rules (but not audit checklists)
  const tokensAndRulesBlock = promptBlock;

  cached = { css, rules, craftGuidelines, referenceExample, promptBlock, rulesOnlyBlock, tokensAndRulesBlock };
  return cached;
}

/** Clear the cache (useful for tests or hot-reloading) */
export function clearDesignSystemCache(): void {
  cached = null;
}

/**
 * Extract just the custom property names from the CSS, grouped by category.
 * e.g. "Colors: --pesto-brand-50, --pesto-brand-100, ..."
 */
function extractTokenNames(css: string): string {
  const tokens = [...css.matchAll(/--(pesto-[\w-]+)\s*:/g)].map((m) => m[1]);
  const groups = new Map<string, string[]>();

  for (const token of tokens) {
    // Group by the second segment: pesto-brand-*, pesto-space-*, etc.
    const parts = token.split("-");
    const category = parts.slice(0, 2).join("-"); // e.g. "pesto-brand"
    const group = groups.get(category) ?? [];
    group.push(`--${token}`);
    groups.set(category, group);
  }

  return [...groups.entries()]
    .map(([category, names]) => `${category}: ${names.join(", ")}`)
    .join("\n");
}

/**
 * Walk up from CWD and common locations to find the design-system directory.
 */
function findDesignSystemDir(): string {
  const candidates = [
    join(process.cwd(), "design-system"),
    join(process.cwd(), "..", "design-system"),
    join(import.meta.dirname ?? process.cwd(), "..", "..", "design-system"),
  ];

  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Could not find design-system directory. Searched:\n${candidates.map((d) => `  - ${d}`).join("\n")}`
  );
}
