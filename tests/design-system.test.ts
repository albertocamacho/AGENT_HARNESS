import { describe, it, expect, beforeEach } from "vitest";
import { loadDesignSystem, clearDesignSystemCache } from "../src/utils/design-system.js";

describe("design system loader", () => {
  beforeEach(() => {
    clearDesignSystemCache();
  });

  it("loads pesto.css, pesto-components.json, and pesto-guidelines.md", () => {
    const ds = loadDesignSystem();

    expect(ds.css).toBeTruthy();
    expect(ds.componentSpecs).toBeTruthy();
    expect(ds.rules).toBeTruthy();
    expect(ds.promptBlock).toBeTruthy();
  });

  it("componentSpecs contains expected component keys", () => {
    const ds = loadDesignSystem();

    const keys = Object.keys(ds.componentSpecs);
    expect(keys).toContain("buttons");
    expect(keys).toContain("cards");
    expect(keys).toContain("forms");
    expect(keys).toContain("typography");
    expect(keys).toContain("navigation");
    expect(keys).toContain("badges");
    expect(keys).toContain("responsive");
  });

  it("css contains core token categories", () => {
    const ds = loadDesignSystem();

    // Brand colors
    expect(ds.css).toContain("--pesto-brand-600");
    // Neutral scale
    expect(ds.css).toContain("--pesto-neutral-900");
    // Typography
    expect(ds.css).toContain("--pesto-font-sans");
    expect(ds.css).toContain("--pesto-text-base");
    // Spacing
    expect(ds.css).toContain("--pesto-space-4");
    // Radii
    expect(ds.css).toContain("--pesto-radius-md");
    // Shadows
    expect(ds.css).toContain("--pesto-shadow-sm");
    // Transitions
    expect(ds.css).toContain("--pesto-duration-normal");
    // Dark mode
    expect(ds.css).toContain('data-theme="dark"');
  });

  it("rules contain all required component sections", () => {
    const ds = loadDesignSystem();

    const requiredSections = [
      "General",
      "Layout",
      "Typography",
      "Buttons",
      "Cards",
      "Forms",
      "Navigation",
      "Images",
      "Responsive",
      "Forbidden Patterns",
    ];

    for (const section of requiredSections) {
      expect(ds.rules).toContain(section);
    }
  });

  it("promptBlock wraps content in design_system tags", () => {
    const ds = loadDesignSystem();

    expect(ds.promptBlock).toContain("<design_system>");
    expect(ds.promptBlock).toContain("</design_system>");
    expect(ds.promptBlock).toContain("<design_tokens>");
    expect(ds.promptBlock).toContain("<component_specs>");
    expect(ds.promptBlock).toContain("<component_rules>");
  });

  it("caches results across calls", () => {
    const first = loadDesignSystem();
    const second = loadDesignSystem();

    // Same reference — cached
    expect(first).toBe(second);
  });

  it("craftGuidelines loads modules from craft/ directory", () => {
    const ds = loadDesignSystem();

    // Anti-patterns always comes first
    expect(ds.craftGuidelines).toMatch(/^# Anti-Patterns/);

    // All 7 craft modules are present
    expect(ds.craftGuidelines).toContain("# Anti-Patterns");
    expect(ds.craftGuidelines).toContain("# Typography");
    expect(ds.craftGuidelines).toContain("# Color & Contrast");
    expect(ds.craftGuidelines).toContain("# Spatial Design");
    expect(ds.craftGuidelines).toContain("# Motion Design");
    expect(ds.craftGuidelines).toContain("# Interaction Design");
    expect(ds.craftGuidelines).toContain("# Responsive Design");
    expect(ds.craftGuidelines).toContain("# UX Writing");
  });

  it("craftGuidelines contains key anti-pattern rules", () => {
    const ds = loadDesignSystem();

    expect(ds.craftGuidelines).toContain("AI Slop Test");
    expect(ds.craftGuidelines).toContain("Cyan-on-dark");
    expect(ds.craftGuidelines).toContain("Glassmorphism");
    expect(ds.craftGuidelines).toContain("Bounce or elastic");
  });

  it("clearCache forces a reload", () => {
    const first = loadDesignSystem();
    clearDesignSystemCache();
    const second = loadDesignSystem();

    // Different reference — reloaded
    expect(first).not.toBe(second);
    // But same content
    expect(first.css).toEqual(second.css);
  });
});
