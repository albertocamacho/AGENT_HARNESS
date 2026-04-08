/**
 * Parses pesto.css into structured token categories and serializes
 * modifications back. Uses regex — no CSS parser dependency needed
 * since the token file follows a strict format.
 */

export interface TokenEntry {
  name: string;
  value: string;
  comment?: string;
}

export type ControlType =
  | "color"
  | "size"
  | "font"
  | "shadow"
  | "transition"
  | "number"
  | "text"
  | "reference"
  | "weight";

export interface TokenCategory {
  label: string;
  prefix: string;
  controlType: ControlType;
  tokens: TokenEntry[];
}

export interface ParsedTokens {
  light: TokenCategory[];
  dark: TokenCategory[];
  rawCss: string;
}

// ── Control type mapping by token prefix segment ──────────────────

const CONTROL_MAP: Record<string, ControlType> = {
  "brand": "color",
  "neutral": "color",
  "accent": "color",
  "error": "color",
  "warning": "color",
  "success": "color",
  "info": "color",
  "surface": "reference",
  "text": "reference",  // text-primary, text-secondary, etc (not text-xs — handled below)
  "border": "reference",
  "font": "font",
  "leading": "size",
  "weight": "weight",
  "space": "size",
  "container": "size",
  "content": "text",
  "radius": "size",
  "shadow": "shadow",
  "duration": "size",
  "ease": "transition",
  "z": "number",
};

// Size tokens in the "text" prefix that are font sizes, not references
const TEXT_SIZE_PATTERN = /^--pesto-text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/;

/** Human-readable labels for prefix categories */
const LABELS: Record<string, string> = {
  "brand": "Brand Colors",
  "neutral": "Neutral Colors",
  "accent": "Accent Colors",
  "error": "Error Colors",
  "warning": "Warning Colors",
  "success": "Success Colors",
  "info": "Info Colors",
  "surface": "Surfaces",
  "text": "Text Colors",
  "border": "Borders",
  "font": "Font Families",
  "leading": "Line Heights",
  "weight": "Font Weights",
  "space": "Spacing",
  "container": "Containers",
  "content": "Content Width",
  "radius": "Border Radius",
  "shadow": "Shadows",
  "duration": "Durations",
  "ease": "Easing",
  "z": "Z-Index",
};

// Separate label for font-size tokens that fall under "text" prefix
const TEXT_SIZE_LABEL = "Font Sizes";

// ── Parsing ───────────────────────────────────────────────────────

const TOKEN_REGEX = /--(pesto-[\w-]+)\s*:\s*(.+?)\s*;(?:\s*\/\*\s*(.*?)\s*\*\/)?/g;

function extractTokensFromBlock(block: string): TokenEntry[] {
  const tokens: TokenEntry[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TOKEN_REGEX.source, "g");
  while ((match = re.exec(block)) !== null) {
    tokens.push({
      name: `--${match[1]}`,
      value: match[2].trim(),
      comment: match[3]?.trim(),
    });
  }
  return tokens;
}

function categorizeTokens(tokens: TokenEntry[]): TokenCategory[] {
  const groups = new Map<string, TokenEntry[]>();
  // Separate font-size tokens from text-color tokens
  const fontSizeTokens: TokenEntry[] = [];

  for (const token of tokens) {
    if (TEXT_SIZE_PATTERN.test(token.name)) {
      fontSizeTokens.push(token);
      continue;
    }

    // Extract the category segment: --pesto-{category}-*
    const parts = token.name.replace("--pesto-", "").split("-");
    const category = parts[0];
    const group = groups.get(category) ?? [];
    group.push(token);
    groups.set(category, group);
  }

  const categories: TokenCategory[] = [];

  for (const [prefix, entries] of groups) {
    if (entries.length === 0) continue;
    categories.push({
      label: LABELS[prefix] ?? prefix,
      prefix,
      controlType: CONTROL_MAP[prefix] ?? "text",
      tokens: entries,
    });
  }

  // Add font-size tokens as their own category
  if (fontSizeTokens.length > 0) {
    categories.push({
      label: TEXT_SIZE_LABEL,
      prefix: "text-size",
      controlType: "size",
      tokens: fontSizeTokens,
    });
  }

  return categories;
}

/**
 * Parse pesto.css into structured light and dark token categories.
 */
export function parseTokens(css: string): ParsedTokens {
  // Extract the main :root block (not inside @media)
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
  const lightTokens = rootMatch ? extractTokensFromBlock(rootMatch[1]) : [];

  // Extract the dark mode :root block
  const darkMatch = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/s);
  const darkTokens = darkMatch ? extractTokensFromBlock(darkMatch[1]) : [];

  return {
    light: categorizeTokens(lightTokens),
    dark: categorizeTokens(darkTokens),
    rawCss: css,
  };
}

/**
 * Apply modified token values to the original CSS string.
 * Preserves all comments, formatting, and non-token CSS.
 */
export function serializeTokens(
  originalCss: string,
  modifiedTokens: Record<string, string>,
): string {
  let css = originalCss;

  for (const [name, newValue] of Object.entries(modifiedTokens)) {
    // Match the token declaration and replace just the value
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(${escapedName}\\s*:\\s*)(.+?)(\\s*;)`,
      "g",
    );
    css = css.replace(pattern, `$1${newValue}$3`);
  }

  return css;
}
