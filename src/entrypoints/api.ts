import "dotenv/config";
import express from "express";
import { nanoid } from "nanoid";
import { createHarness } from "../core/factory.js";
import type { HarnessResult, ProgressEvent } from "../core/types.js";

const app = express();
app.use(express.json());

// Store for completed/in-progress runs
const runs = new Map<string, { status: string; result?: HarnessResult; events: ProgressEvent[] }>();

const harness = createHarness({
  planner: (process.env.PLANNER as "static" | "llm") ?? "static",
});

// ── POST /generate ──────────────────────────────────────────────
// Start a generation run. Returns immediately with a run ID.
app.post("/generate", async (req, res) => {
  const { prompt, constraints } = req.body;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const id = nanoid();
  const events: ProgressEvent[] = [];
  runs.set(id, { status: "running", events });

  // Fire and forget — client polls /runs/:id
  harness
    .run({
      id,
      prompt,
      constraints,
      onProgress: (event) => events.push(event),
    })
    .then((result) => {
      runs.set(id, { status: "complete", result, events });
    })
    .catch((err) => {
      runs.set(id, {
        status: "error",
        events: [
          ...events,
          { type: "error", error: err instanceof Error ? err.message : String(err) },
        ],
      });
    });

  res.status(202).json({ id, status: "running" });
});

// ── POST /generate/sync ────────────────────────────────────────
// Synchronous generation — waits for completion, returns full result.
app.post("/generate/sync", async (req, res) => {
  const { prompt, constraints } = req.body;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const result = await harness.run({
      id: nanoid(),
      prompt,
      constraints,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── GET /runs/:id ───────────────────────────────────────────────
// Poll for run status and result.
app.get("/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// ── GET /runs/:id/html ──────────────────────────────────────────
// Get just the HTML output (for iframe embedding, etc.)
app.get("/runs/:id/html", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run?.result) {
    res.status(404).json({ error: "Run not found or not complete" });
    return;
  }
  res.type("html").send(run.result.html);
});

// ── GET /runs/:id/pages/:pageId ─────────────────────────────────
// Get a specific page's HTML (for multi-page runs)
app.get("/runs/:id/pages/:pageId", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run?.result) {
    res.status(404).json({ error: "Run not found or not complete" });
    return;
  }
  const pageHtml = run.result.pages?.[req.params.pageId];
  if (!pageHtml) {
    res.status(404).json({ error: `Page "${req.params.pageId}" not found` });
    return;
  }
  res.type("html").send(pageHtml);
});

// ── GET /agents ─────────────────────────────────────────────────
app.get("/agents", (_req, res) => {
  res.json({ agents: harness.listAgents() });
});

// ── Health check ────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", agents: harness.listAgents().length });
});

const port = parseInt(process.env.PORT ?? "3100", 10);
app.listen(port, () => {
  console.log(`Agent harness API running on http://localhost:${port}`);
  console.log(`Agents: ${harness.listAgents().join(", ")}`);
});

export { app };
