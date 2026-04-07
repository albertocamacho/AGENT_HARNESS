import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { ValidatorAgent } from "../src/agents/validator.js";
import { createHarness } from "../src/core/factory.js";
import type { HarnessRequest, HarnessResult, SharedContext, ProgressEvent } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Fixtures ─────────────────────────────────────────────────────

export function loadFixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf-8");
}

// ── Run the validator in isolation against raw HTML ───────────────

export async function runValidatorOn(
  html: string,
  label = "fixture test"
): Promise<{
  correctedHtml: string;
  audit: string;
  passed: boolean;
  violationCount: number;
}> {
  const validator = new ValidatorAgent();

  const ctx: SharedContext = {
    request: { id: nanoid(), prompt: label },
    artifacts: { final_html: html },
    data: {},
  };

  const request: HarnessRequest = { id: ctx.request.id, prompt: label };
  const output = await validator.execute(ctx, request);

  return {
    correctedHtml: output.artifact,
    audit: (output.data?.audit as string) ?? "",
    passed: (output.data?.passed as boolean) ?? false,
    violationCount: (output.data?.violationCount as number) ?? 0,
  };
}

// ── Run the full pipeline ────────────────────────────────────────

export async function runFullPipeline(
  prompt: string,
  opts: { planner?: "static" | "llm" } = {}
): Promise<{ result: HarnessResult; events: ProgressEvent[] }> {
  const harness = createHarness({ planner: opts.planner ?? "static" });
  const events: ProgressEvent[] = [];

  const result = await harness.run({
    id: nanoid(),
    prompt,
    onProgress: (e) => events.push(e),
  });

  return { result, events };
}

// ── Assertion helpers ────────────────────────────────────────────

/** Find hardcoded hex colors outside of CSS custom property definitions */
export function findHardcodedColors(html: string): string[] {
  const style = extractStyleBlock(html);
  if (!style) return [];

  const nonVarLines = style
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
  return (nonVarLines.match(hexPattern) ?? []).filter((m) => m.length >= 4);
}

/** Count inline style attributes in the body */
export function findInlineStyles(html: string): number {
  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  if (!bodyMatch) return 0;
  return (bodyMatch[0].match(/\sstyle\s*=/gi) ?? []).length;
}

/** Find heading hierarchy skips (e.g. h1 → h3) */
export function findHeadingSkips(html: string): string[] {
  const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((m) =>
    parseInt(m[1], 10)
  );
  const skips: string[] = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) {
      skips.push(`h${headings[i - 1]} → h${headings[i]}`);
    }
  }
  return skips;
}

/** Rough check: inputs that outnumber labels */
export function findUnlabeledInputs(html: string): number {
  const inputs = (html.match(/<input\b/gi) ?? []).length;
  const labels = (html.match(/<label\b/gi) ?? []).length;
  return Math.max(0, inputs - labels);
}

/** Count images without alt attributes */
export function findMissingAlt(html: string): number {
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
  return imgs.filter((m) => !m[0].includes("alt=")).length;
}

/** Check for uses of var(--pesto-*) in the style block */
export function countPestoTokenUsage(html: string): number {
  const style = extractStyleBlock(html);
  if (!style) return 0;
  return (style.match(/var\(--pesto-/g) ?? []).length;
}

function extractStyleBlock(html: string): string | null {
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match?.[1] ?? null;
}
