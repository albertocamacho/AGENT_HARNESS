import { describe, it, expect } from "vitest";
import {
  runFullPipeline,
  findHardcodedColors,
  findInlineStyles,
  findHeadingSkips,
  findUnlabeledInputs,
  countPestoTokenUsage,
} from "../helpers.js";

/*
 * End-to-end pipeline tests. These run the FULL architect → renderer →
 * validator pipeline with real LLM calls.
 *
 * Each test takes 60-120s (three sequential LLM calls).
 * Requires ANTHROPIC_API_KEY.
 */

describe("e2e: full pipeline", { timeout: 300_000 }, () => {
  it("should generate a compliant landing page from a prompt", async () => {
    const { result, events } = await runFullPipeline(
      "A simple landing page for a plant nursery called Green Thumb. " +
      "Include a hero section, a three-card feature grid, and a footer."
    );

    // ── Pipeline structure ──────────────────────────────
    // All three agents should have run
    const agentNames = result.meta.agentSteps.map((s) => s.agentName);
    expect(agentNames).toContain("architect");
    expect(agentNames).toContain("renderer");
    expect(agentNames).toContain("validator");

    // Progress events should be well-formed
    const starts = events.filter((e) => e.type === "agent_start");
    const completes = events.filter((e) => e.type === "agent_complete");
    expect(starts.length).toBe(3);
    expect(completes.length).toBe(3);

    // ── Output validity ─────────────────────────────────
    expect(result.html).toContain("<!DOCTYPE html");
    expect(result.html).toContain("</html>");
    expect(result.html.length).toBeGreaterThan(500);

    // ── Design system compliance ────────────────────────
    // Should use Pesto tokens extensively
    const tokenCount = countPestoTokenUsage(result.html);
    expect(tokenCount).toBeGreaterThan(10);

    // Should have minimal hardcoded colors
    const hardcoded = findHardcodedColors(result.html);
    expect(hardcoded.length).toBeLessThanOrEqual(3); // allow a few edge cases

    // Should have no inline styles
    const inlineStyles = findInlineStyles(result.html);
    expect(inlineStyles).toBe(0);

    // Should have valid heading hierarchy
    const headingSkips = findHeadingSkips(result.html);
    expect(headingSkips.length).toBe(0);

    // ── Validation audit ────────────────────────────────
    const audit = result.data.audit as string;
    const violationCount = result.data.violationCount as number;
    expect(audit).toBeDefined();

    // ── Metadata ────────────────────────────────────────
    expect(result.meta.durationMs).toBeGreaterThan(0);
    expect(result.meta.tokenUsage.input).toBeGreaterThan(0);
    expect(result.meta.tokenUsage.output).toBeGreaterThan(0);

    console.log("\n  ── Pipeline Results ──");
    console.log(`  Duration: ${(result.meta.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${result.meta.tokenUsage.input} in / ${result.meta.tokenUsage.output} out`);
    console.log(`  Pesto tokens used: ${tokenCount}`);
    console.log(`  Hardcoded colors remaining: ${hardcoded.length}`);
    console.log(`  Inline styles: ${inlineStyles}`);
    console.log(`  Heading skips: ${headingSkips.length}`);
    console.log(`  Validator violations: ${violationCount}`);
    console.log(`  HTML size: ${(result.html.length / 1024).toFixed(1)}KB`);

    for (const step of result.meta.agentSteps) {
      console.log(
        `  Agent "${step.agentName}": ${step.durationMs}ms, ` +
        `${step.tokenUsage.input}+${step.tokenUsage.output} tokens`
      );
    }
  });

  it("should handle a form-heavy page and ensure labels exist", async () => {
    const { result } = await runFullPipeline(
      "A contact form page with fields for name, email, phone, and a message textarea. " +
      "Include a heading, a short intro paragraph, and a submit button."
    );

    expect(result.html).toContain("<!DOCTYPE html");

    // All inputs should have labels after validation
    const unlabeled = findUnlabeledInputs(result.html);
    expect(unlabeled).toBe(0);

    // Pesto tokens should be used
    const tokenCount = countPestoTokenUsage(result.html);
    expect(tokenCount).toBeGreaterThan(10);

    console.log("\n  ── Form Page Results ──");
    console.log(`  Duration: ${(result.meta.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Unlabeled inputs: ${unlabeled}`);
    console.log(`  Pesto tokens: ${tokenCount}`);
  });
});
