import { describe, it, expect, beforeEach } from "vitest";
import { loadDesignSystem, clearDesignSystemCache } from "../src/utils/design-system.js";

describe("design system loader", () => {
  beforeEach(() => {
    clearDesignSystemCache();
  });

  it("loads pesto.css and pesto-components.md", () => {
    const ds = loadDesignSystem();

    expect(ds.css).toBeTruthy();
    expect(ds.rules).toBeTruthy();
    expect(ds.promptBlock).toBeTruthy();
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
    expect(ds.css).toContain("prefers-color-scheme: dark");
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
      "Badges",
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
    expect(ds.promptBlock).toContain("<component_rules>");
  });

  it("caches results across calls", () => {
    const first = loadDesignSystem();
    const second = loadDesignSystem();

    // Same reference — cached
    expect(first).toBe(second);
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
