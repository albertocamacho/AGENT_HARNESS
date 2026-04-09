import { llmCall } from "../utils/llm.js";
import type { PageConstraints } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface PageSpec {
  /** Short kebab-case identifier, e.g. "home", "dashboard", "settings" */
  id: string;
  /** Human-readable page name */
  title: string;
  /** What this page contains / its purpose */
  description: string;
  /** Whether this is the main entry point */
  isLanding: boolean;
}

export interface ComplexityPlan {
  tier: "single" | "multi";
  pages: PageSpec[];
}

// ─── Classifier ─────────────────────────────────────────────────

/**
 * Analyze a prompt and determine whether it needs one page or multiple.
 * Uses Haiku for speed — this should add < 5s of overhead.
 */
/**
 * Quick regex check for obvious single-page prompts.
 * Returns a ComplexityPlan if confident, or null to fall through to LLM.
 */
function quickClassify(prompt: string): ComplexityPlan | null {
  const lower = prompt.toLowerCase();

  // Obvious single-page patterns
  const singlePatterns = [
    /^a\s+(landing|pricing|login|signup|about|contact|blog|faq|error|404)\s+page/i,
    /^(create|build|make|design)\s+a\s+(single|one|simple)\s+page/i,
    /^a\s+(restaurant|product|portfolio|resume|cv)\s+(menu|page|site|website)\b/i,
  ];
  for (const pat of singlePatterns) {
    if (pat.test(prompt)) return fallbackSingle(prompt);
  }

  // Obvious multi-page: prompt mentions multiple distinct pages/sections with "and"
  // e.g. "with a dashboard, a settings page, and a reports page"
  const multiSignals = lower.match(/\b(?:page|view|screen|tab|section)\b/gi) || [];
  const withClause = lower.match(/with\s+(?:a\s+)?[\w\s]+(?:,\s*(?:a\s+)?[\w\s]+)+(?:,?\s*and\s+(?:a\s+)?[\w\s]+)/i);

  if (multiSignals.length >= 2 || withClause) {
    // Looks multi-page — still need the LLM to extract page specs
    return null;
  }

  // If the prompt is very short and doesn't mention multiple things, assume single
  if (lower.split(/\s+/).length < 15 && !lower.includes(' and ')) {
    return fallbackSingle(prompt);
  }

  return null; // uncertain, use LLM
}

export async function detectComplexity(
  prompt: string,
  constraints?: PageConstraints,
): Promise<ComplexityPlan> {
  // Fast path: skip LLM for obvious cases
  const quick = quickClassify(prompt);
  if (quick) return quick;

  const systemPrompt = `You classify web page generation requests into complexity tiers.

Tier "single": The request describes one page or a narrowly scoped view.
  Examples: "a pricing page", "a blog post about cats", "a login form",
  "a landing page for a SaaS product", "a restaurant menu page"

Tier "multi": The request describes an application or site with multiple
  distinct pages/views that share navigation.
  Examples: "a project management web app", "an e-commerce store",
  "a portfolio site with about, work, and contact pages",
  "a dashboard application with analytics, settings, and user management"

Respond with ONLY valid JSON matching this schema:
{
  "tier": "single" | "multi",
  "pages": [
    {
      "id": "kebab-case-id",
      "title": "Page Title",
      "description": "What this page contains",
      "isLanding": true/false
    }
  ]
}

Rules:
- For "single" tier: return exactly 1 page
- For "multi" tier: return 2-5 pages (keep it focused, not exhaustive)
- Exactly one page must have isLanding: true
- Page ids must be unique kebab-case strings
- Descriptions should be specific enough for a UX architect to design from`;

  let userPrompt = `Classify this request: "${prompt}"`;
  if (constraints?.pageType) {
    userPrompt += `\nPage type hint: ${constraints.pageType}`;
  }

  const response = await llmCall({
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 1000,
    model: "claude-haiku-4-5-20251001",
    temperature: 0.3,
  });

  try {
    // Strip markdown code fences if present
    const cleaned = response.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as ComplexityPlan;

    // Validate structure
    if (!parsed.tier || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      return fallbackSingle(prompt);
    }

    // Ensure exactly one landing page
    const landingCount = parsed.pages.filter((p) => p.isLanding).length;
    if (landingCount === 0) {
      parsed.pages[0].isLanding = true;
    } else if (landingCount > 1) {
      let found = false;
      for (const page of parsed.pages) {
        if (page.isLanding && found) page.isLanding = false;
        if (page.isLanding) found = true;
      }
    }

    return parsed;
  } catch {
    return fallbackSingle(prompt);
  }
}

function fallbackSingle(prompt: string): ComplexityPlan {
  return {
    tier: "single",
    pages: [
      {
        id: "main",
        title: "Main Page",
        description: prompt,
        isLanding: true,
      },
    ],
  };
}
