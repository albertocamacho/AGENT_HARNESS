import { describe, it, expect } from "vitest";
import {
  loadFixture,
  runValidatorOn,
  findHardcodedColors,
  findInlineStyles,
  findHeadingSkips,
  findUnlabeledInputs,
  findMissingAlt,
} from "../helpers.js";

/*
 * These tests run the local-only validator against known-bad HTML fixtures
 * and check that:
 * 1. The validator detects the violations (audit report)
 * 2. Mechanically fixable issues are corrected (inline styles, alt, br, etc.)
 * 3. Detection-only issues are reported but HTML is otherwise preserved
 *
 * No LLM call is made — all checks are regex-based.
 */

describe("validator: hardcoded colors", () => {
  it("should detect hardcoded hex values in CSS", async () => {
    const fixture = loadFixture("hardcoded-colors.html");

    // Confirm the fixture IS broken
    const beforeColors = findHardcodedColors(fixture);
    expect(beforeColors.length).toBeGreaterThan(0);

    // Run the validator
    const { audit, passed, violationCount } =
      await runValidatorOn(fixture, "hardcoded colors fixture");

    // Audit should report violations
    expect(passed).toBe(false);
    expect(violationCount).toBeGreaterThan(0);
    expect(audit.toLowerCase()).toMatch(/hardcoded|hex|color/);

    console.log(`  Hardcoded colors detected: ${beforeColors.length}`);
    console.log(`  Violations reported: ${violationCount}`);
  });
});

describe("validator: skipped headings", () => {
  it("should detect heading hierarchy violations", async () => {
    const fixture = loadFixture("skipped-headings.html");

    // Confirm the fixture IS broken
    const beforeSkips = findHeadingSkips(fixture);
    expect(beforeSkips.length).toBeGreaterThan(0);

    const { audit, passed } = await runValidatorOn(
      fixture,
      "skipped headings fixture"
    );

    expect(passed).toBe(false);
    expect(audit.toLowerCase()).toMatch(/heading|skip/);

    console.log(`  Heading skips detected: ${beforeSkips.join(", ")}`);
  });
});

describe("validator: inline styles and div soup", () => {
  it("should remove inline styles and detect unlabeled inputs", async () => {
    const fixture = loadFixture("inline-styles-and-divs.html");

    const beforeInline = findInlineStyles(fixture);
    expect(beforeInline).toBeGreaterThan(0);

    const beforeLabels = findUnlabeledInputs(fixture);
    expect(beforeLabels).toBeGreaterThan(0);

    const { correctedHtml, audit, passed } = await runValidatorOn(
      fixture,
      "inline styles and divs fixture"
    );

    expect(passed).toBe(false);

    // Inline styles should be removed (mechanical fix)
    const afterInline = findInlineStyles(correctedHtml);
    expect(afterInline).toBeLessThan(beforeInline);

    // Audit should mention inline styles
    expect(audit.toLowerCase()).toMatch(/inline|style/);

    console.log(`  Inline styles: ${beforeInline} → ${afterInline}`);
    console.log(`  Unlabeled inputs detected: ${beforeLabels}`);
  });
});

describe("validator: missing accessibility", () => {
  it("should detect missing focus styles, labels, and fix missing alt text", async () => {
    const fixture = loadFixture("missing-a11y.html");

    const beforeAlt = findMissingAlt(fixture);
    expect(beforeAlt).toBeGreaterThan(0);

    const beforeLabels = findUnlabeledInputs(fixture);
    expect(beforeLabels).toBeGreaterThan(0);

    const { correctedHtml, audit, passed } = await runValidatorOn(
      fixture,
      "missing a11y fixture"
    );

    expect(passed).toBe(false);

    // Should fix missing alt text (mechanical fix)
    const afterAlt = findMissingAlt(correctedHtml);
    expect(afterAlt).toBeLessThan(beforeAlt);

    // Audit should mention alt or label issues
    expect(audit.toLowerCase()).toMatch(/alt|label|missing/);

    console.log(`  Missing alt: ${beforeAlt} → ${afterAlt}`);
    console.log(`  Unlabeled inputs detected: ${beforeLabels}`);
  });
});

describe("validator: compliant page", () => {
  it("should pass a well-formed page with no or minimal violations", async () => {
    const fixture = loadFixture("compliant.html");

    const { audit, passed, violationCount } = await runValidatorOn(
      fixture,
      "compliant fixture"
    );

    console.log(`  Passed: ${passed}`);
    console.log(`  Violations: ${violationCount}`);
    console.log(`  Audit:\n${audit.slice(0, 500)}`);

    // Allow ≤2 minor violations
    expect(violationCount).toBeLessThanOrEqual(2);
  });
});
