# Agent Harness

An orchestrator for LLM agents that design full HTML pages, enforced by the Pesto design system.

## How it works

Every request flows through three phases regardless of entry point:

1. **Architect** — Plans the UX: page structure, content, visual design, responsive behavior. Designs within the Pesto token system. Outputs a detailed spec.
2. **Renderer** — Takes the spec and produces a complete, self-contained HTML file using Pesto CSS custom properties.
3. **Validator** — Audits the rendered HTML against every Pesto rule (tokens, components, typography, accessibility, forbidden patterns). Fixes all violations and reports what it found.

The orchestrator manages handoffs, passes context between agents, and surfaces the audit report.

## Design system

The `design-system/` directory holds the source of truth:

- **`pesto.css`** — CSS custom properties for colors, spacing, typography, surfaces, transitions, z-index. All generated pages must use these tokens exclusively.
- **`pesto-components.json`** — CSS property specs for each component (buttons, cards, forms, nav, badges, typography, layout, responsive).
- **`pesto-guidelines.md`** — Behavioral rules, accessibility requirements, and forbidden patterns.

All files are loaded at startup and injected into every agent's system prompt. The validator checks every rule in `pesto-guidelines.md`, every spec in `pesto-components.json`, and every token in `pesto.css`.

To customize the design system, edit these files. No code changes needed — agents pick up the new rules on next run.

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

### CLI

```bash
# Generate a page
npm run cli -- generate "A landing page for a coffee subscription service"

# With constraints
npm run cli -- generate "Dashboard for a fitness app" \
  --type dashboard \
  --output dashboard.html

# The audit report prints automatically:
#   ⚠ Design system: 3 violation(s) found and fixed
#   --- Audit Report ---
#   - Hardcoded hex #333 on .hero-title → replaced with var(--pesto-text-primary)
#   ...

# List agents
npm run cli -- agents
```

### REST API

```bash
npm run api
```

```bash
# Synchronous
curl -X POST http://localhost:3100/generate/sync \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A portfolio site for a photographer"}'

# Response includes:
# {
#   "html": "<!DOCTYPE html>...",
#   "data": {
#     "audit": "...",
#     "violationCount": 2,
#     "passed": false
#   },
#   "meta": { ... }
# }

# Async
curl -X POST http://localhost:3100/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A blog post layout"}'

curl http://localhost:3100/runs/<id>
curl http://localhost:3100/runs/<id>/html
```

### Web UI

```bash
npm run web
# Open http://localhost:3100
```

### Programmatic (SDK)

```typescript
import { createHarness } from "agent-harness";
import { nanoid } from "nanoid";

const harness = createHarness();

const result = await harness.run({
  id: nanoid(),
  prompt: "A pricing page with three tiers",
  onProgress: (event) => console.log(event.type),
});

console.log(result.html);
console.log(result.data.passed);          // true if no violations
console.log(result.data.violationCount);  // number of fixes applied
console.log(result.data.audit);           // full audit report
```

## Adding agents

Extend `BaseAgent` and register:

```typescript
import { BaseAgent, extractTag } from "agent-harness";

class SEOAgent extends BaseAgent {
  name = "seo";
  description = "Adds meta tags and structured data";
  protected artifactKey = "seo_meta";
  protected systemPrompt = `You are an SEO specialist...`;

  protected buildPrompt(ctx, request) {
    return `Add SEO metadata for: "${request.prompt}"`;
  }

  protected parseResponse(raw: string) {
    return { artifact: extractTag(raw, "seo") };
  }
}

const harness = createHarness({ extraAgents: [new SEOAgent()] });
```

## Project structure

```
├── design-system/
│   ├── pesto.css               # Design tokens (colors, spacing, type, etc.)
│   ├── pesto-components.json   # Component CSS property specs
│   └── pesto-guidelines.md     # Behavioral rules and forbidden patterns
├── src/
│   ├── core/
│   │   ├── types.ts            # All interfaces and types
│   │   ├── orchestrator.ts     # Pipeline executor + state management
│   │   ├── planners.ts         # Static and LLM pipeline planners
│   │   └── factory.ts          # createHarness() convenience
│   ├── agents/
│   │   ├── base.ts             # BaseAgent abstract class
│   │   ├── architect.ts        # UX planning agent (reads design system)
│   │   ├── renderer.ts         # HTML implementation agent (reads design system)
│   │   ├── validator.ts        # Compliance auditor (reads design system)
│   │   └── index.ts            # Registry + defaults
│   ├── entrypoints/
│   │   ├── cli.ts              # Commander CLI
│   │   ├── api.ts              # Express REST API
│   │   └── web.ts              # Web UI + WebSocket
│   ├── utils/
│   │   ├── llm.ts              # Anthropic SDK wrapper
│   │   └── design-system.ts    # Loads and caches pesto.css + rules
│   └── index.ts                # Barrel export
├── package.json
└── tsconfig.json
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `PORT` | `3100` | Server port for API / Web UI |
| `PLANNER` | `static` | Pipeline planner: `static` or `llm` |
