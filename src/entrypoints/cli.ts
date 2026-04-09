#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { nanoid } from "nanoid";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve, dirname, basename, extname, join } from "path";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { exec } from "child_process";
import { createHarness } from "../core/factory.js";
import type { ProgressEvent } from "../core/types.js";

const program = new Command();

program
  .name("harness")
  .description("Generate HTML pages using orchestrated LLM agents")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate an HTML page from a text prompt")
  .argument("<prompt...>", "Description of the page to generate")
  .option("-o, --output <file>", "Output file path", "output.html")
  .option("-t, --type <pageType>", "Page type hint (e.g. landing, dashboard, blog)")
  .option("--palette <colors...>", "Color palette (space-separated hex codes)")
  .option("--planner <type>", "Pipeline planner: static or llm", "static")
  .option("--quiet", "Suppress progress output")
  .option("-s, --serve [port]", "Serve the output on localhost after generation")
  .option("-l, --live [port]", "Live preview in browser during generation")
  .option("--no-validate", "Skip the validation step")
  .action(async (promptParts: string[], opts) => {
    const prompt = promptParts.join(" ");
    const harness = createHarness({ planner: opts.planner });

    // Start live preview server if requested
    let sendSSE: ((type: string, data: unknown) => void) | undefined;
    if (opts.live !== undefined) {
      const port = typeof opts.live === "string" ? parseInt(opts.live, 10) : 3200;
      const live = startLivePreview(port);
      sendSSE = live.sendEvent;
      // Give browser a moment to connect
      await new Promise((r) => setTimeout(r, 600));
    }

    const onProgress = opts.quiet
      ? undefined
      : (event: ProgressEvent) => {
          // Send to live preview browser if active
          if (sendSSE) {
            sendSSE(event.type, event);
          }

          switch (event.type) {
            case "pipeline_start":
              console.log(
                `\n▶ Pipeline: ${event.pipeline.steps.length} steps planned`
              );
              break;
            case "agent_start":
              process.stdout.write(`  ⟳ ${event.agentName} (phase ${event.phase})...`);
              break;
            case "agent_complete":
              console.log(` done (${event.result.durationMs}ms)`);
              break;
            case "pipeline_complete":
              console.log(
                `\n✓ Complete in ${event.result.meta.durationMs}ms`
              );
              console.log(
                `  Tokens: ${event.result.meta.tokenUsage.input} in / ${event.result.meta.tokenUsage.output} out`
              );
              break;
            case "error":
              console.error(`\n✗ Error in ${event.agentName}: ${event.error}`);
              break;
          }
        };

    try {
      const result = await harness.run({
        id: nanoid(),
        prompt,
        constraints: {
          pageType: opts.type,
          palette: opts.palette,
        },
        skipValidation: !opts.validate,
        onProgress,
      });

      // Show the architect spec if available
      if (result.data.spec) {
        console.log("\n--- Architect Spec ---");
        console.log(result.data.spec);
        console.log("--- End Spec ---");
      }

      // Write output file(s)
      let outputDir: string | undefined;
      if (result.pages && Object.keys(result.pages).length > 1) {
        const outputBase = basename(opts.output, extname(opts.output) || ".html");
        outputDir = resolve(dirname(opts.output), outputBase);
        mkdirSync(outputDir, { recursive: true });

        const ext = extname(opts.output) || ".html";
        for (const [pageId, pageHtml] of Object.entries(result.pages)) {
          const filePath = join(outputDir, `${pageId}${ext}`);
          writeFileSync(filePath, pageHtml, "utf-8");
          console.log(`  → ${filePath}`);
        }

        // Copy pesto.css as a safety net for any pages that reference it externally
        try {
          const { loadDesignSystem } = await import("../utils/design-system.js");
          writeFileSync(join(outputDir, "pesto.css"), loadDesignSystem().css, "utf-8");
        } catch { /* non-fatal */ }

        console.log(`\n��� ${Object.keys(result.pages).length} pages written to ${outputDir}/`);
      } else {
        writeFileSync(opts.output, result.html, "utf-8");
        console.log(`\n→ Written to ${opts.output}`);
      }

      // Show validation audit if available
      if (result.data.audit) {
        const passed = result.data.passed;
        const count = result.data.violationCount ?? "?";
        console.log(
          passed
            ? "\n✓ Design system: all checks passed"
            : `\n⚠ Design system: ${count} violation(s) found and fixed`
        );
        if (!opts.quiet && !passed) {
          console.log("\n--- Audit Report ---");
          console.log(result.data.audit);
          console.log("--- End Report ---");
        }
      }

      // Send final result to live preview
      if (sendSSE) {
        sendSSE("result", { type: "result", result });
        console.log(`\n🌐 Live preview running — press Ctrl+C to stop`);
      }

      // Serve the file if requested
      if (opts.serve !== undefined && opts.live === undefined) {
        const port = typeof opts.serve === "string" ? parseInt(opts.serve, 10) : 3200;
        if (outputDir) {
          const landing = Object.keys(result.pages!)[0];
          serveDirectory(outputDir, landing, port);
        } else {
          serveFile(resolve(opts.output), port);
        }
      }
    } catch (err) {
      console.error("Generation failed:", err);
      process.exit(1);
    }
  });

program
  .command("agents")
  .description("List all registered agents")
  .action(() => {
    const harness = createHarness();
    console.log("Registered agents:");
    for (const name of harness.listAgents()) {
      console.log(`  - ${name}`);
    }
  });

program
  .command("design")
  .description("Open the visual design system editor")
  .option("-p, --port <port>", "Port to serve the editor on", "3300")
  .action(async (opts) => {
    const { default: express } = await import("express");
    const { parseTokens, serializeTokens } = await import("../editor/token-parser.js");
    const { loadDesignSystem, writeDesignSystemCss, clearDesignSystemCache } = await import("../utils/design-system.js");

    const app = express();
    app.use(express.json({ limit: "1mb" }));

    const editorPath = join(
      import.meta.dirname ?? process.cwd(),
      "..", "editor", "design-editor.html"
    );

    // Serve the editor UI
    app.get("/", (_req, res) => {
      try {
        const html = readFileSync(editorPath, "utf-8");
        res.type("html").send(html);
      } catch (err) {
        res.status(500).send(`Failed to load editor: ${err}`);
      }
    });

    // Return parsed tokens as JSON
    app.get("/api/tokens", (_req, res) => {
      clearDesignSystemCache();
      const ds = loadDesignSystem();
      const parsed = parseTokens(ds.css);
      res.json(parsed);
    });

    // Save modified CSS
    app.post("/api/tokens", (req, res) => {
      try {
        const { css } = req.body;
        if (!css || typeof css !== "string") {
          res.status(400).json({ error: "Missing css field" });
          return;
        }
        writeDesignSystemCss(css);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Return component specs
    app.get("/api/components", (_req, res) => {
      try {
        const compPath = join(
          import.meta.dirname ?? process.cwd(),
          "..", "..", "design-system", "pesto-components.json"
        );
        const raw = readFileSync(compPath, "utf-8");
        res.json(JSON.parse(raw));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Save component specs
    app.post("/api/components", (req, res) => {
      try {
        const compPath = join(
          import.meta.dirname ?? process.cwd(),
          "..", "..", "design-system", "pesto-components.json"
        );
        writeFileSync(compPath, JSON.stringify(req.body, null, 2) + "\n", "utf-8");
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Serve raw pesto.css
    app.get("/api/pesto.css", (_req, res) => {
      clearDesignSystemCache();
      const ds = loadDesignSystem();
      res.type("css").send(ds.css);
    });

    const port = parseInt(opts.port, 10);

    // Kill any leftover process on the port before starting
    try {
      const { execSync } = await import("child_process");
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
    } catch { /* nothing to kill */ }

    const server = app.listen(port, () => {
      console.log(`\nPesto Design System Editor: http://localhost:${port}`);
      console.log("  Edit tokens visually, toggle dark mode, and save back to disk.");
      console.log("  Press Ctrl+C to stop.\n");
      exec(`open http://localhost:${port}`);
    });

    // Graceful shutdown
    const shutdown = () => { server.close(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

function serveFile(filePath: string, port: number) {
  const server = createServer((_req, res) => {
    try {
      const html = readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("Failed to read file");
    }
  });

  server.listen(port, () => {
    console.log(`\n🌐 Serving at http://localhost:${port}`);
    console.log(`   File: ${filePath}`);
    console.log(`   (re-reads from disk on each request — edit & refresh)`);
    console.log(`   Press Ctrl+C to stop\n`);
  });
}

function serveDirectory(dir: string, landingPageId: string, port: number) {
  const server = createServer((req, res) => {
    try {
      // Map / to the landing page
      let requestedFile = `${landingPageId}.html`;
      const match = req.url?.match(/^\/([\w-]+)\.html$/);
      if (match) requestedFile = `${match[1]}.html`;

      const filePath = join(dir, requestedFile);
      const html = readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      // Fall back to landing page for unknown routes
      try {
        const html = readFileSync(join(dir, `${landingPageId}.html`), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Page not found");
      }
    }
  });

  server.listen(port, () => {
    console.log(`\n🌐 Serving at http://localhost:${port}`);
    console.log(`   Directory: ${dir}`);
    console.log(`   Landing: ${landingPageId}.html`);
    console.log(`   (re-reads from disk on each request — edit & refresh)`);
    console.log(`   Press Ctrl+C to stop\n`);
  });
}

// ─── Live preview server ────────────────────────────────────────

function startLivePreview(port: number) {
  const sseClients: ServerResponse[] = [];
  let finalHtml: string | null = null;
  let finalPages: Record<string, string> | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      });
      // If generation already completed, replay the result to the new client
      if (finalHtml) {
        const resultPayload = { type: "result", result: { html: finalHtml, pages: finalPages } };
        res.write(`data: ${JSON.stringify(resultPayload)}\n\n`);
      }
      return;
    }

    // Serve a specific page for multi-page results (supports both /page/id and /id.html)
    if (finalPages) {
      let pageId: string | undefined;
      if (req.url?.startsWith("/page/")) {
        pageId = req.url.slice(6);
      } else {
        const match = req.url?.match(/^\/([\w-]+)\.html$/);
        if (match) pageId = match[1];
      }
      if (pageId) {
        const pageHtml = finalPages[pageId];
        if (pageHtml) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(pageHtml);
          return;
        }
      }
    }

    // Always serve the app shell — it reconnects to SSE and loads the result
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LIVE_PREVIEW_HTML);
  });

  server.listen(port, () => {
    console.log(`\n🌐 Live preview at http://localhost:${port}`);
    exec(`open http://localhost:${port}`);
  });

  function sendEvent(type: string, data: unknown) {
    const d = data as any;
    // Capture the final result so reloads serve it directly
    if (d.type === "result" && d.result) {
      finalHtml = d.result.html;
      if (d.result.pages) finalPages = d.result.pages;
    }
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  }

  return { server, sendEvent };
}

const LIVE_PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Preview</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* ── Shell design tokens (dark chrome, warm neutrals from Pesto) ── */
    :root {
      --sh-bg: #181716;
      --sh-bg-raised: #1f1e1c;
      --sh-bg-sunken: #121110;
      --sh-bg-hover: #282624;
      --sh-border: #2a2826;
      --sh-border-subtle: #222120;
      --sh-text-primary: #E3E1DF;
      --sh-text-secondary: #908B87;
      --sh-text-tertiary: #5F5E5A;
      --sh-text-muted: #474542;
      --sh-accent: #22c55e;
      --sh-accent-soft: rgba(34,197,94,0.12);
      --sh-accent-text: #86efac;
      --sh-active: #22c55e;
      --sh-active-soft: rgba(34,197,94,0.08);
      --sh-working: #f59e0b;
      --sh-working-soft: rgba(245,158,11,0.10);
      --sh-radius: 8px;
      --sh-radius-sm: 5px;
      --sh-transition: 200ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      height: 100vh; display: flex;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      background: #F9F8F7;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Side Nav ── */
    .sidenav {
      width: 256px; flex-shrink: 0;
      background: var(--sh-bg); color: var(--sh-text-secondary);
      display: flex; flex-direction: column;
      border-right: 1px solid var(--sh-border);
      font-size: 13px;
      transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
    }
    .sidenav-header {
      padding: 20px 20px 16px;
      border-bottom: 1px solid var(--sh-border-subtle);
    }
    .sidenav-title {
      font-size: 13px; font-weight: 600; color: var(--sh-text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-bottom: 3px; letter-spacing: -0.01em;
    }
    .sidenav-sub { font-size: 11px; color: var(--sh-text-tertiary); }

    .sidenav-body { flex: 1; overflow-y: auto; padding: 16px 0; }
    .sidenav-body::-webkit-scrollbar { width: 3px; }
    .sidenav-body::-webkit-scrollbar-track { background: transparent; }
    .sidenav-body::-webkit-scrollbar-thumb { background: var(--sh-border); border-radius: 3px; }

    .sidenav-section { padding: 0 20px; margin-bottom: 24px; }
    .sidenav-section-label {
      font-size: 10px; font-weight: 600; color: var(--sh-text-muted);
      text-transform: uppercase; letter-spacing: 0.08em;
      margin-bottom: 12px;
    }

    /* Steps */
    .steps { display: flex; flex-direction: column; gap: 0; }
    .step-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 0; position: relative;
    }
    .step-track {
      display: flex; flex-direction: column; align-items: center;
      width: 20px; flex-shrink: 0;
    }
    .step-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--sh-bg-raised); border: 2px solid var(--sh-border);
      transition: all var(--sh-transition); flex-shrink: 0; position: relative;
    }
    .step-line {
      width: 2px; height: 20px;
      background: var(--sh-border-subtle);
      transition: background var(--sh-transition);
    }
    .step-row.active .step-dot {
      background: var(--sh-working); border-color: var(--sh-working);
      box-shadow: 0 0 0 3px var(--sh-working-soft);
    }
    .step-row.active .step-dot::after {
      content: ''; position: absolute; inset: 1px; border-radius: 50%;
      background: var(--sh-working); animation: pulse 1.5s infinite;
    }
    .step-row.done .step-dot { background: var(--sh-accent); border-color: var(--sh-accent); }
    .step-row.done .step-line { background: var(--sh-accent); }
    .step-row.active .step-line { background: var(--sh-working); }
    .step-info { padding: 0 0 16px; min-width: 0; }
    .step-name {
      font-size: 12px; color: var(--sh-text-tertiary);
      transition: color var(--sh-transition);
      line-height: 1; padding-top: 0;
    }
    .step-row.active .step-name { color: #fbbf24; font-weight: 500; }
    .step-row.done .step-name { color: var(--sh-accent-text); }
    .step-duration {
      font-size: 10px; color: var(--sh-text-muted);
      margin-top: 3px; font-variant-numeric: tabular-nums;
    }
    .step-row.done .step-duration { color: var(--sh-text-tertiary); }

    /* Pages */
    .page-list { display: flex; flex-direction: column; gap: 3px; }
    .page-item {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px; border-radius: var(--sh-radius-sm);
      background: transparent; border-left: 2px solid transparent;
      transition: all var(--sh-transition); cursor: default;
    }
    .page-item:hover { background: var(--sh-bg-raised); }
    .page-item.active { border-left-color: var(--sh-working); background: var(--sh-working-soft); }
    .page-item.done { border-left-color: var(--sh-accent); background: var(--sh-active-soft); }
    .page-icon { font-size: 11px; color: var(--sh-text-muted); }
    .page-item.active .page-icon { color: #fbbf24; }
    .page-item.done .page-icon { color: var(--sh-accent); }
    .page-name {
      font-size: 11px; color: var(--sh-text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .page-item.active .page-name { color: #fde68a; }
    .page-item.done .page-name { color: var(--sh-accent-text); }

    /* Footer */
    .sidenav-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--sh-border-subtle);
      display: flex; justify-content: space-between; align-items: center;
    }
    .timer {
      font-size: 18px; font-weight: 600; color: var(--sh-text-muted);
      font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
      transition: color 300ms;
    }
    .timer.running { color: var(--sh-text-secondary); }
    .timer.done { color: var(--sh-accent); }
    .timer-label { font-size: 10px; color: var(--sh-text-muted); margin-top: 1px; }

    /* ── Main Area ── */
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

    .page-tabs {
      display: none;
      background: var(--sh-bg);
      padding: 0 16px; border-bottom: 1px solid var(--sh-border);
      flex-shrink: 0;
    }
    .page-tabs.visible { display: flex; }
    .page-tab {
      padding: 10px 16px; font-size: 12px; font-weight: 500;
      background: none; color: var(--sh-text-tertiary); border: none;
      border-bottom: 2px solid transparent; cursor: pointer;
      transition: all 150ms;
    }
    .page-tab:hover { color: var(--sh-text-primary); }
    .page-tab.active { color: var(--sh-text-primary); border-bottom-color: var(--sh-accent); }
    iframe { flex: 1; border: none; width: 100%; background: #F9F8F7; }

    /* ── Collapse toggle ── */
    .collapse-btn {
      display: none;
      width: 26px; height: 26px;
      background: var(--sh-bg-raised); border: 1px solid var(--sh-border); border-radius: var(--sh-radius-sm);
      color: var(--sh-text-tertiary); font-size: 13px;
      cursor: pointer; transition: all 150ms;
      align-items: center; justify-content: center; flex-shrink: 0;
    }
    .collapse-btn:hover { background: var(--sh-bg-hover); color: var(--sh-text-primary); }
    .collapse-btn.visible { display: inline-flex; }

    /* ── Collapsed state ── */
    .sidenav.collapsed { width: 44px; }
    .sidenav.collapsed .sidenav-header { padding: 10px 0; justify-content: center; }
    .sidenav.collapsed .sidenav-header > div:first-child { display: none; }
    .sidenav.collapsed .sidenav-section-label { display: none; }
    .sidenav.collapsed .step-info { display: none; }
    .sidenav.collapsed .step-track { width: 12px; }
    .sidenav.collapsed .step-dot { width: 8px; height: 8px; }
    .sidenav.collapsed .step-line { height: 12px; }
    .sidenav.collapsed .steps { align-items: center; padding-left: 8px; }
    .sidenav.collapsed .page-name { display: none; }
    .sidenav.collapsed .page-item {
      padding: 6px; justify-content: center;
      border-left-width: 0; border-radius: var(--sh-radius-sm);
    }
    .sidenav.collapsed .page-item.active { background: var(--sh-working-soft); }
    .sidenav.collapsed .page-item.done { background: var(--sh-active-soft); }
    .sidenav.collapsed .sidenav-footer { padding: 8px; flex-direction: column; gap: 4px; }
    .sidenav.collapsed .timer { font-size: 10px; }
    .sidenav.collapsed .timer-label { display: none; }
    .sidenav.collapsed #summary { display: none; }
    .sidenav.collapsed .sidenav-body { padding: 8px 0; }
    .sidenav.collapsed .sidenav-section { padding: 0 6px; margin-bottom: 12px; }
    .sidenav.collapsed .page-list { gap: 2px; }

    .completion-dot {
      display: none;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--sh-accent); margin: 0 auto;
    }
    .sidenav.collapsed .completion-dot.visible { display: block; }

    /* ── Planning overlay ── */
    .planning-overlay {
      position: absolute; inset: 0; z-index: 5;
      background: var(--sh-bg-sunken);
      display: flex; flex-direction: column; align-items: center;
      padding: 80px 40px;
      overflow-y: auto;
      transition: opacity 500ms ease-out;
    }
    .planning-overlay.hidden { opacity: 0; pointer-events: none; }
    .planning-card { width: 100%; max-width: 480px; }
    .planning-title {
      font-size: 11px; font-weight: 600; color: var(--sh-text-muted);
      text-transform: uppercase; letter-spacing: 0.1em;
      margin-bottom: 36px;
    }
    .planning-title span { color: var(--sh-text-secondary); }
    .planning-pages {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-bottom: 32px;
    }
    .planning-page-tag {
      padding: 5px 12px;
      background: var(--sh-bg-raised); border: 1px solid var(--sh-border); border-radius: var(--sh-radius-sm);
      font-size: 12px; color: var(--sh-text-secondary); font-weight: 500;
      animation: planFade 400ms ease-out;
    }
    .planning-sections { display: flex; flex-direction: column; gap: 0; }
    .planning-section {
      padding: 10px 0;
      border-bottom: 1px solid var(--sh-border-subtle);
      animation: planFade 400ms ease-out;
    }
    .planning-section-name {
      font-size: 12px; font-weight: 500; color: var(--sh-text-secondary);
      margin-bottom: 3px;
    }
    .planning-section-detail {
      font-size: 11px; color: var(--sh-text-muted);
      line-height: 1.6; max-width: 460px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .planning-cursor {
      display: inline-block; width: 5px; height: 13px;
      background: var(--sh-accent); border-radius: 1px;
      animation: blink 1s steps(1) infinite;
      vertical-align: middle; margin-left: 4px;
    }

    /* ── View toggle ── */
    .view-toggle {
      display: none;
      background: var(--sh-bg); border-bottom: 1px solid var(--sh-border);
      padding: 8px 16px; gap: 4px; flex-shrink: 0;
    }
    .view-toggle.visible { display: flex; }
    .view-btn {
      padding: 5px 14px; font: 500 11px "Inter", system-ui, sans-serif;
      background: none; border: 1px solid transparent; border-radius: var(--sh-radius-sm);
      color: var(--sh-text-tertiary); cursor: pointer;
      transition: all 150ms;
    }
    .view-btn:hover { color: var(--sh-text-primary); }
    .view-btn.active {
      background: var(--sh-bg-raised); border-color: var(--sh-border);
      color: var(--sh-text-primary);
    }

    /* ── Canvas view ── */
    .canvas-view {
      display: none; flex: 1;
      background: var(--sh-bg-sunken);
      background-image: radial-gradient(circle, var(--sh-border-subtle) 1px, transparent 1px);
      background-size: 24px 24px;
      overflow: auto; padding: 48px;
    }
    .canvas-view.visible { display: flex; }
    .canvas-layout { position: relative; margin: auto; }
    .canvas-container { display: flex; align-items: flex-start; gap: 80px; }
    .canvas-landing { display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .canvas-others { display: flex; flex-direction: column; gap: 24px; }

    .canvas-card {
      width: 280px; border-radius: var(--sh-radius); overflow: hidden;
      background: var(--sh-bg); border: 1px solid var(--sh-border);
      cursor: pointer;
      transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
    }
    .canvas-card:hover {
      border-color: var(--sh-accent);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .canvas-card.landing { border-color: var(--sh-accent); }
    .canvas-card.skeleton .canvas-thumb { background: var(--sh-bg-raised); }
    .canvas-card.skeleton .canvas-thumb::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 25%, var(--sh-bg-hover) 50%, transparent 75%);
      background-size: 200% 100%;
      animation: shimmer 1.8s ease-in-out infinite;
    }
    .canvas-card.rendering { border-color: var(--sh-working); }
    .canvas-card.rendering .canvas-thumb::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 25%, var(--sh-working-soft) 50%, transparent 75%);
      background-size: 200% 100%;
      animation: shimmer 1.8s ease-in-out infinite;
    }
    .canvas-card.ready { border-color: var(--sh-accent); }
    .canvas-card.ready .canvas-thumb::after { display: none; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    .canvas-thumb {
      width: 280px; height: 180px; overflow: hidden;
      position: relative; background: #F9F8F7;
    }
    .canvas-thumb iframe {
      width: 1400px; height: 900px; border: none;
      transform: scale(0.2); transform-origin: top left;
      pointer-events: none;
    }
    .canvas-card-info { padding: 12px 14px; }
    .canvas-card-title {
      font-size: 12px; font-weight: 600; color: var(--sh-text-primary);
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 3px; letter-spacing: -0.01em;
    }
    .canvas-card-desc {
      font-size: 11px; color: var(--sh-text-tertiary); line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .landing-badge {
      display: inline-block; padding: 2px 7px;
      background: var(--sh-accent-soft); color: var(--sh-accent);
      font-size: 9px; font-weight: 600; border-radius: 3px;
      text-transform: uppercase; letter-spacing: 0.05em;
    }

    .canvas-svg {
      position: absolute; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; overflow: visible;
    }
    .canvas-svg path, .canvas-svg polyline, .canvas-svg line {
      fill: none; stroke: var(--sh-text-muted); stroke-width: 1.5;
      stroke-linejoin: round; stroke-linecap: round;
      transition: stroke 200ms, stroke-width 200ms;
    }
    .canvas-svg circle {
      fill: var(--sh-text-muted);
      transition: fill 200ms;
    }
    .canvas-svg polygon {
      fill: var(--sh-text-muted);
      transition: fill 200ms;
    }
    .canvas-svg .conn-group:hover path,
    .canvas-svg .conn-group:hover line,
    .canvas-svg .conn-group:hover polyline,
    .canvas-svg .conn-group.hovered path,
    .canvas-svg .conn-group.hovered line,
    .canvas-svg .conn-group.hovered polyline { stroke: var(--sh-accent); stroke-width: 2; }
    .canvas-svg .conn-group:hover circle,
    .canvas-svg .conn-group:hover polygon,
    .canvas-svg .conn-group.hovered circle,
    .canvas-svg .conn-group.hovered polygon { fill: var(--sh-accent); }
    .canvas-svg .conn-group:hover .conn-label rect,
    .canvas-svg .conn-group.hovered .conn-label rect { fill: var(--sh-accent); }
    .canvas-svg .conn-group:hover .conn-label text,
    .canvas-svg .conn-group.hovered .conn-label text { fill: var(--sh-bg); }
    .canvas-svg .conn-group { pointer-events: auto; cursor: default; }
    .canvas-svg .conn-label text {
      font-family: "Inter", system-ui, sans-serif;
      font-size: 9px; font-weight: 600;
      fill: var(--sh-text-muted);
      text-anchor: middle; dominant-baseline: central;
      letter-spacing: 0.04em;
    }
    .canvas-svg .conn-label rect {
      fill: var(--sh-bg-raised);
      rx: 3; ry: 3;
      transition: fill 200ms;
    }
    /* Highlight connected lines when hovering a card */
    .canvas-card:hover ~ .canvas-svg .conn-group path { stroke: var(--sh-border); }
    .canvas-card:hover ~ .canvas-svg .conn-group circle,
    .canvas-card:hover ~ .canvas-svg .conn-group polygon { fill: var(--sh-border); }

    @keyframes planFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  </style>
</head>
<body>
  <nav class="sidenav" id="sidenav">
    <div class="sidenav-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="min-width:0">
        <div class="sidenav-title" id="navTitle">Generating...</div>
        <div class="sidenav-sub" id="navSub">Starting pipeline</div>
      </div>
      <button class="collapse-btn" id="collapseBtn" onclick="toggleNav()" title="Toggle sidebar">&lsaquo;</button>
    </div>
    <div class="sidenav-body">
      <div class="sidenav-section">
        <div class="sidenav-section-label">Progress</div>
        <div class="steps" id="steps"></div>
      </div>
      <div class="sidenav-section" id="pagesSection" style="display:none">
        <div class="sidenav-section-label">Pages</div>
        <div class="page-list" id="pageList"></div>
      </div>
    </div>
    <div class="sidenav-footer">
      <div>
        <div class="timer" id="timer">0.0s</div>
        <div class="timer-label">elapsed</div>
      </div>
      <div id="summary" style="text-align:right"></div>
      <div class="completion-dot" id="completionDot"></div>
    </div>
  </nav>
  <div class="main" style="position:relative">
    <div class="planning-overlay" id="planningOverlay">
      <div class="planning-card">
        <div class="planning-title">Planning your app<span class="planning-cursor"></span></div>
        <div class="planning-pages" id="planningPages"></div>
        <div class="planning-sections" id="planningSections"></div>
      </div>
    </div>
    <div class="view-toggle" id="viewToggle">
      <button class="view-btn active" id="viewProto" onclick="switchView('prototype')">Prototype</button>
      <button class="view-btn" id="viewFlow" onclick="switchView('flow')">Flow</button>
    </div>
    <div class="page-tabs" id="page-tabs"></div>
    <div id="prototypeView" style="display:flex;flex:1;min-height:0;">
      <iframe id="preview" style="flex:1;"></iframe>
    </div>
    <div class="canvas-view" id="canvasView">
      <div class="canvas-layout" id="canvasLayout">
        <div class="canvas-container" id="canvasContainer"></div>
        <svg class="canvas-svg" id="canvasSvg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
  </div>
  <script>
    let pestoCss = '';
    let architectBuffer = '';
    let planningDebounce = null;
    let lastPlanningPages = new Set();
    let lastPlanningSections = [];
    let rendererBuffer = '';
    let iframeDocOpened = false;
    let pendingChunks = '';
    let rafId = 0;
    let streamingAgent = '';
    let resultPages = null;
    let startTime = Date.now();
    let timerInterval = null;
    let pipelineSteps = [];
    let stepStartTimes = {};
    let completedAgents = new Set();
    let activeAgents = new Set();

    const iframe = document.getElementById('preview');

    // ── Timer ──
    function startTimer() {
      startTime = Date.now();
      document.getElementById('timer').className = 'timer running';
      timerInterval = setInterval(() => {
        document.getElementById('timer').textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
      }, 100);
    }
    function stopTimer() {
      if (timerInterval) clearInterval(timerInterval);
      document.getElementById('timer').className = 'timer done';
    }

    // ── Steps ──
    function buildSteps(steps) {
      const phases = new Map();
      for (const s of steps) {
        if (!phases.has(s.phase)) phases.set(s.phase, []);
        phases.get(s.phase).push(s.agentName);
      }
      pipelineSteps = [];
      for (const [phase, agents] of [...phases.entries()].sort((a,b) => a[0]-b[0])) {
        let label = 'Phase ' + phase;
        if (agents.some(a => a === 'architect' || a === 'shell')) label = 'Planning & design';
        else if (agents.some(a => a.startsWith('renderer'))) label = 'Building pages';
        else if (agents.some(a => a.startsWith('validator'))) label = 'Validating';
        pipelineSteps.push({ id: 'phase-' + phase, label, agents });
      }

      const container = document.getElementById('steps');
      container.innerHTML = '';
      pipelineSteps.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'step-row';
        row.id = 'srow-' + p.id;
        row.innerHTML =
          '<div class="step-track"><div class="step-dot"></div>' +
          (i < pipelineSteps.length - 1 ? '<div class="step-line"></div>' : '') +
          '</div>' +
          '<div class="step-info"><div class="step-name">' + p.label + '</div><div class="step-duration" id="sdur-' + p.id + '"></div></div>';
        container.appendChild(row);
      });
    }

    function updateSteps() {
      for (const p of pipelineSteps) {
        const el = document.getElementById('srow-' + p.id);
        if (!el) continue;
        const allDone = p.agents.every(a => completedAgents.has(a));
        const anyActive = p.agents.some(a => activeAgents.has(a));
        el.className = 'step-row' + (allDone ? ' done' : anyActive ? ' active' : '');
      }
    }

    // ── Pages ──
    function buildPages(steps) {
      const renderers = steps.filter(s => s.agentName.startsWith('renderer_'));
      if (renderers.length === 0) return;
      document.getElementById('pagesSection').style.display = '';
      const container = document.getElementById('pageList');
      container.innerHTML = '';
      for (const r of renderers) {
        const pageId = r.agentName.replace('renderer_', '');
        const item = document.createElement('div');
        item.className = 'page-item';
        item.id = 'pitem-' + pageId;
        item.innerHTML = '<span class="page-icon">&#9634;</span><span class="page-name">' + pageId.replace(/-/g, ' ') + '</span>';
        container.appendChild(item);
      }
    }

    function updatePageItem(agentName, state) {
      const pageId = agentName.replace('renderer_', '').replace('validator_', '');
      const item = document.getElementById('pitem-' + pageId);
      if (item) {
        item.className = 'page-item ' + state;
        if (state === 'done') item.querySelector('.page-icon').innerHTML = '&#10003;';
      }
    }

    // ── Planning view ──
    function updatePlanningView(buf) {
      clearTimeout(planningDebounce);
      planningDebounce = setTimeout(() => renderPlanningView(buf), 150);
    }

    function renderPlanningView(buf) {
      // Extract page IDs from <spec id="page-id"> tags
      const pageMatches = [...buf.matchAll(/<spec\\s+id=["']([^"']+)["']/gi)];
      const pages = pageMatches.map(m => m[1]);
      const pagesContainer = document.getElementById('planningPages');
      for (const p of pages) {
        if (!lastPlanningPages.has(p)) {
          lastPlanningPages.add(p);
          const tag = document.createElement('div');
          tag.className = 'planning-page-tag';
          tag.textContent = p.replace(/-/g, ' ');
          pagesContainer.appendChild(tag);
        }
      }

      // Extract section headers and their first line of content
      const sections = [];
      const headerRegex = /^##\\s+(.+)$/gm;
      let match;
      while ((match = headerRegex.exec(buf)) !== null) {
        const name = match[1].trim();
        // Skip "Page: xxx" wrapper headers
        if (name.toLowerCase().startsWith('page:')) continue;
        // Get the first non-empty line after the header
        const afterHeader = buf.substring(match.index + match[0].length);
        const lines = afterHeader.split('\\n').filter(l => l.trim().length > 0);
        const detail = lines[0]?.trim().replace(/^[-*]\\s*/, '').substring(0, 120) || '';
        sections.push({ name, detail });
      }

      // Only update DOM if new sections appeared
      if (sections.length > lastPlanningSections.length) {
        const container = document.getElementById('planningSections');
        for (let i = lastPlanningSections.length; i < sections.length; i++) {
          const s = sections[i];
          const div = document.createElement('div');
          div.className = 'planning-section';
          div.innerHTML =
            '<div class="planning-section-name">' + s.name + '</div>' +
            (s.detail ? '<div class="planning-section-detail">' + s.detail + '</div>' : '');
          container.appendChild(div);
        }
        lastPlanningSections = sections;
        // Auto-scroll to show latest
        const overlay = document.getElementById('planningOverlay');
        overlay.scrollTop = overlay.scrollHeight;
      }

      // Update title with page count if known
      const title = document.querySelector('.planning-title');
      if (pages.length > 0) {
        title.innerHTML = 'Planning ' + pages.length + ' pages<span class="planning-cursor"></span>';
      }
    }

    // ── Iframe streaming (safe: waits for <body> before writing) ──
    let headWritten = false;
    let lastBodyPos = 0;

    function flushChunks() {
      rafId = 0;
      if (!pendingChunks) return;
      try { const doc = iframe.contentDocument; if (doc) doc.write(pendingChunks); } catch (e) {}
      pendingChunks = '';
    }
    function scheduleFlush() { if (!rafId) rafId = requestAnimationFrame(flushChunks); }

    function stripOutputTags(buf) {
      return buf.replace(/^[\\s\\S]*?<html_output>\\s*/i, '').replace(/<\\/html_output>[\\s\\S]*$/i, '');
    }

    /** Try to stream body content safely. Returns true if we wrote something. */
    function tryStreamBody() {
      const cleaned = stripOutputTags(rendererBuffer);

      // Wait until we see <body to ensure all <style> blocks are complete
      if (!headWritten) {
        const bodyIdx = cleaned.search(/<body[\\s>]/i);
        if (bodyIdx === -1) return; // still in <head>, keep buffering

        // Open iframe and write everything up to and including <body...>
        const bodyTagEnd = cleaned.indexOf('>', bodyIdx) + 1;
        if (bodyTagEnd === 0) return; // <body tag not closed yet

        try {
          const doc = iframe.contentDocument;
          doc.open();

          // Inject design tokens as inline <style> right after <head> so CSS is
          // available immediately — no waiting for external stylesheet to load
          let headContent = cleaned.substring(0, bodyTagEnd);
          if (pestoCss) {
            headContent = headContent.replace(
              /<head([^>]*)>/i,
              '<head$1><style id="pesto-tokens-inline">' + pestoCss + '</style>'
            );
          }

          doc.write(headContent);
          headWritten = true;
          lastBodyPos = bodyTagEnd;
          iframeDocOpened = true;
        } catch (e) { return; }
      }

      // Stream new body content incrementally
      const cleaned2 = stripOutputTags(rendererBuffer);
      const newContent = cleaned2.substring(lastBodyPos);
      if (newContent) {
        pendingChunks += newContent;
        lastBodyPos = cleaned2.length;
        scheduleFlush();
      }
    }

    function switchPage(pageId) {
      if (!resultPages || !resultPages[pageId]) return;
      iframe.srcdoc = resultPages[pageId];
      document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.textContent === pageId));
      // Update page list highlight
      document.querySelectorAll('.page-item').forEach(p => {
        const pid = p.id.replace('pitem-', '');
        p.classList.toggle('active', pid === pageId);
      });
    }

    function interceptIframeLinks() {
      if (!resultPages) return;
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href');
          const match = href && href.match(/^([\\w-]+)\\.html$/);
          if (match && resultPages[match[1]]) {
            a.addEventListener('click', (e) => { e.preventDefault(); switchPage(match[1]); });
          }
        });
      } catch (e) {}
    }
    iframe.addEventListener('load', interceptIframeLinks);

    // ── Nav collapse ──
    let navCollapsed = false;

    function toggleNav() {
      navCollapsed = !navCollapsed;
      const nav = document.getElementById('sidenav');
      const btn = document.getElementById('collapseBtn');
      nav.classList.toggle('collapsed', navCollapsed);
      btn.innerHTML = navCollapsed ? '&rsaquo;' : '&lsaquo;';
    }

    function collapseNav() {
      if (navCollapsed) return;
      navCollapsed = true;
      document.getElementById('sidenav').classList.add('collapsed');
      document.getElementById('collapseBtn').innerHTML = '&rsaquo;';
      document.getElementById('completionDot').classList.add('visible');
    }

    function showCollapseBtn() {
      document.getElementById('collapseBtn').classList.add('visible');
    }

    // ── View switching ──
    let viewMode = 'prototype';
    let pageSpecs = null;

    function switchView(mode) {
      viewMode = mode;
      document.getElementById('prototypeView').style.display = mode === 'prototype' ? 'flex' : 'none';
      document.getElementById('canvasView').classList.toggle('visible', mode === 'flow');
      document.getElementById('page-tabs').style.display = mode === 'prototype' && resultPages ? '' : 'none';
      document.getElementById('viewProto').classList.toggle('active', mode === 'prototype');
      document.getElementById('viewFlow').classList.toggle('active', mode === 'flow');
      // Draw lines after the canvas is visible and laid out
      if (mode === 'flow') {
        scheduleDrawLines();
      }
    }

    // ── Canvas flow view ──
    /** Build skeleton canvas cards before any pages are rendered */
    function buildSkeletonCanvas(rendererSteps) {
      const container = document.getElementById('canvasContainer');
      container.innerHTML = '';

      // First renderer is likely the landing page
      const landingId = rendererSteps[0].agentName.replace('renderer_', '');
      const otherIds = rendererSteps.slice(1).map(s => s.agentName.replace('renderer_', ''));

      const landingCol = document.createElement('div');
      landingCol.className = 'canvas-landing';
      landingCol.appendChild(createSkeletonCard(landingId, true));
      container.appendChild(landingCol);

      if (otherIds.length > 0) {
        const othersCol = document.createElement('div');
        othersCol.className = 'canvas-others';
        for (const pid of otherIds) {
          othersCol.appendChild(createSkeletonCard(pid, false));
        }
        container.appendChild(othersCol);
      }
    }

    function createSkeletonCard(pageId, isLanding) {
      const card = document.createElement('div');
      card.className = 'canvas-card skeleton' + (isLanding ? ' landing' : '');
      card.id = 'ccard-' + pageId;

      const thumb = document.createElement('div');
      thumb.className = 'canvas-thumb';
      thumb.id = 'cthumb-' + pageId;
      card.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'canvas-card-info';
      info.innerHTML =
        '<div class="canvas-card-title">' +
        pageId.replace(/-/g, ' ') +
        (isLanding ? ' <span class="landing-badge">entry</span>' : '') +
        '</div>' +
        '<div class="canvas-card-desc">Generating...</div>';
      card.appendChild(info);

      return card;
    }

    /** Update a canvas card with real page HTML thumbnail */
    function updateCanvasCardThumb(pageId, html) {
      const card = document.getElementById('ccard-' + pageId);
      if (!card) return;

      // Switch from skeleton/rendering to ready
      card.className = card.className.replace(/skeleton|rendering/g, '').trim() + ' ready';

      // Insert thumbnail iframe
      const thumb = document.getElementById('cthumb-' + pageId);
      if (thumb) {
        thumb.innerHTML = '';
        const thumbIframe = document.createElement('iframe');
        thumbIframe.srcdoc = html;
        thumbIframe.setAttribute('loading', 'lazy');
        thumb.appendChild(thumbIframe);
      }

      // Update description
      const desc = card.querySelector('.canvas-card-desc');
      if (desc) desc.textContent = 'Ready — click to preview';

      // Make card clickable
      card.style.cursor = 'pointer';
      card.onclick = () => { switchView('prototype'); switchPage(pageId); };

      // Update link count
      const allPageIds = resultPages ? Object.keys(resultPages) : [];
      const linkCount = allPageIds.filter(id => id !== pageId).length;
      const existing = card.querySelector('[data-link-count]');
      if (!existing) {
        const countEl = document.createElement('div');
        countEl.setAttribute('data-link-count', '');
        countEl.style.cssText = 'margin-top:4px;font-size:10px;color:var(--sh-text-muted)';
        countEl.textContent = linkCount + ' linked page' + (linkCount !== 1 ? 's' : '');
        card.querySelector('.canvas-card-info').appendChild(countEl);
      }

      // Redraw SVG lines if canvas is visible
      if (viewMode === 'flow') {
        scheduleDrawLines();
      }
    }

    /** Add or update a page tab for progressive delivery */
    function addOrUpdatePageTab(pageId) {
      const tabs = document.getElementById('page-tabs');
      tabs.classList.add('visible');

      // Don't duplicate
      if (document.getElementById('ptab-' + pageId)) return;

      const btn = document.createElement('button');
      btn.className = 'page-tab' + (tabs.children.length === 0 ? ' active' : '');
      btn.id = 'ptab-' + pageId;
      btn.textContent = pageId;
      btn.onclick = () => switchPage(pageId);
      tabs.appendChild(btn);
    }

    function buildCanvas(pages, specs) {
      const container = document.getElementById('canvasContainer');
      container.innerHTML = '';

      // Build navigation graph by parsing links in each page's HTML
      const graph = {};
      for (const [pid, html] of Object.entries(pages)) {
        const links = [...html.matchAll(/href=["']([\w-]+)\.html["']/g)].map(m => m[1]);
        graph[pid] = [...new Set(links.filter(id => id !== pid && pages[id]))];
      }

      // Find landing page
      const landingSpec = specs ? specs.find(s => s.isLanding) : null;
      const landingId = landingSpec ? landingSpec.id : Object.keys(pages)[0];

      // Create landing card on the left
      const landingCol = document.createElement('div');
      landingCol.className = 'canvas-landing';
      landingCol.appendChild(createCanvasCard(landingId, pages[landingId], specs, true));
      container.appendChild(landingCol);

      // Create other pages column
      const otherIds = Object.keys(pages).filter(id => id !== landingId);
      if (otherIds.length > 0) {
        const othersCol = document.createElement('div');
        othersCol.className = 'canvas-others';
        for (const pid of otherIds) {
          othersCol.appendChild(createCanvasCard(pid, pages[pid], specs, false));
        }
        container.appendChild(othersCol);
      }

      // Schedule a line draw — ResizeObserver will also trigger this
      scheduleDrawLines();
    }

    function createCanvasCard(pageId, html, specs, isLanding) {
      const spec = specs ? specs.find(s => s.id === pageId) : null;
      const title = spec ? spec.title : pageId.replace(/-/g, ' ');
      const desc = spec ? spec.description : '';

      const card = document.createElement('div');
      card.className = 'canvas-card' + (isLanding ? ' landing' : '');
      card.id = 'ccard-' + pageId;
      card.onclick = () => { switchView('prototype'); switchPage(pageId); };

      // Thumbnail via scaled iframe
      const thumb = document.createElement('div');
      thumb.className = 'canvas-thumb';
      const thumbIframe = document.createElement('iframe');
      thumbIframe.srcdoc = html;
      thumbIframe.setAttribute('loading', 'lazy');
      thumb.appendChild(thumbIframe);
      card.appendChild(thumb);

      // Info
      const info = document.createElement('div');
      info.className = 'canvas-card-info';

      // Count outgoing nav links (every page links to every other via shared nav)
      const allPageIds = resultPages ? Object.keys(resultPages) : [];
      const linkCount = allPageIds.filter(id => id !== pageId).length;

      info.innerHTML =
        '<div class="canvas-card-title">' +
        title +
        (isLanding ? ' <span class="landing-badge">entry</span>' : '') +
        '</div>' +
        (desc ? '<div class="canvas-card-desc">' + desc + '</div>' : '') +
        '<div style="margin-top:6px;font-size:10px;color:var(--sh-text-muted)">' +
        linkCount + ' linked page' + (linkCount !== 1 ? 's' : '') + '</div>';
      card.appendChild(info);

      return card;
    }

    // ── SVG line drawing helpers ──

    /** Walk offsetParent chain to get position relative to an ancestor */
    function getOffsetRelativeTo(el, ancestor) {
      let x = 0, y = 0;
      let current = el;
      while (current && current !== ancestor) {
        x += current.offsetLeft;
        y += current.offsetTop;
        current = current.offsetParent;
      }
      return { x, y };
    }

    /** Debounced draw scheduler — coalesces multiple triggers into one frame */
    let drawLinesRAF = 0;
    function scheduleDrawLines() {
      if (drawLinesRAF) cancelAnimationFrame(drawLinesRAF);
      drawLinesRAF = requestAnimationFrame(() => {
        drawLinesRAF = 0;
        drawCanvasLines();
      });
    }

    function drawCanvasLines() {
      const svg = document.getElementById('canvasSvg');
      const layout = document.getElementById('canvasLayout');
      if (!svg || !layout) return;

      const allCards = layout.querySelectorAll('.canvas-card');
      if (allCards.length < 2) return;

      svg.innerHTML = '';
      if (!layout.offsetWidth) return;

      const w = layout.offsetWidth;
      const h = layout.offsetHeight;
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      // Collect all card positions
      const cardIds = [];
      allCards.forEach(card => cardIds.push(card.id.replace('ccard-', '')));

      const specs = pageSpecs || [];
      const landingSpec = specs.find(s => s.isLanding);
      const landingId = landingSpec ? landingSpec.id : cardIds[0];

      // Determine which card is on the left (landing) vs right (others)
      // Draw connections from landing to each other card
      const landingCard = document.getElementById('ccard-' + landingId);
      if (!landingCard || landingCard.offsetWidth === 0) return;

      const otherIds = cardIds.filter(id => id !== landingId);

      for (const otherId of otherIds) {
        const otherCard = document.getElementById('ccard-' + otherId);
        if (!otherCard || otherCard.offsetWidth === 0) continue;

        const fromPos = getOffsetRelativeTo(landingCard, layout);
        const toPos = getOffsetRelativeTo(otherCard, layout);

        // Connect right edge of landing → left edge of other
        const x1 = fromPos.x + landingCard.offsetWidth;
        const y1 = fromPos.y + landingCard.offsetHeight / 2;
        const x2 = toPos.x;
        const y2 = toPos.y + otherCard.offsetHeight / 2;

        // Elbow pipe: go right to midpoint, turn vertically, turn right to target
        const midX = (x1 + x2) / 2;

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'conn-group');
        group.setAttribute('data-from', landingId);
        group.setAttribute('data-to', otherId);

        // Right-angle pipe path with rounded corners via arc segments
        const r = Math.min(12, Math.abs(y2 - y1) / 2, Math.abs(midX - x1) / 2);
        let d;
        if (Math.abs(y2 - y1) < 1) {
          // Straight horizontal line
          d = 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;
        } else {
          const dir = y2 > y1 ? 1 : -1;
          d = 'M ' + x1 + ' ' + y1 +
            ' L ' + (midX - r) + ' ' + y1 +
            ' A ' + r + ' ' + r + ' 0 0 ' + (dir > 0 ? '1' : '0') + ' ' + midX + ' ' + (y1 + r * dir) +
            ' L ' + midX + ' ' + (y2 - r * dir) +
            ' A ' + r + ' ' + r + ' 0 0 ' + (dir > 0 ? '0' : '1') + ' ' + (midX + r) + ' ' + y2 +
            ' L ' + x2 + ' ' + y2;
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        group.appendChild(path);

        // Invisible wider hit area for hover
        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('d', d);
        hitArea.setAttribute('stroke', 'transparent');
        hitArea.setAttribute('stroke-width', '16');
        hitArea.setAttribute('fill', 'none');
        group.appendChild(hitArea);

        // Arrow at destination (pointing right)
        const as = 5;
        const arrowEnd = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowEnd.setAttribute('points',
          x2 + ',' + y2 + ' ' +
          (x2 - as * 2) + ',' + (y2 - as) + ' ' +
          (x2 - as * 2) + ',' + (y2 + as)
        );
        group.appendChild(arrowEnd);

        // Arrow at source (pointing left — bidirectional)
        const arrowStart = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowStart.setAttribute('points',
          x1 + ',' + y1 + ' ' +
          (x1 + as * 2) + ',' + (y1 - as) + ' ' +
          (x1 + as * 2) + ',' + (y1 + as)
        );
        group.appendChild(arrowStart);

        // "nav" label at the vertical midpoint of the pipe
        const labelX = midX;
        const labelY = (y1 + y2) / 2;
        const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelGroup.setAttribute('class', 'conn-label');

        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const labelW = 28, labelH = 16;
        labelBg.setAttribute('x', labelX - labelW / 2);
        labelBg.setAttribute('y', labelY - labelH / 2);
        labelBg.setAttribute('width', labelW);
        labelBg.setAttribute('height', labelH);
        labelGroup.appendChild(labelBg);

        const labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        labelText.setAttribute('x', labelX);
        labelText.setAttribute('y', labelY);
        labelText.textContent = 'nav';
        labelGroup.appendChild(labelText);

        group.appendChild(labelGroup);
        svg.appendChild(group);
      }

      // Draw a single vertical rail on the left side of the "others" column
      // connecting all sibling cards (they all link to each other via nav)
      if (otherIds.length > 1) {
        const firstCard = document.getElementById('ccard-' + otherIds[0]);
        const lastCard = document.getElementById('ccard-' + otherIds[otherIds.length - 1]);
        if (firstCard && lastCard && firstCard.offsetWidth && lastCard.offsetWidth) {
          const firstPos = getOffsetRelativeTo(firstCard, layout);
          const lastPos = getOffsetRelativeTo(lastCard, layout);

          const x = firstPos.x - 16;
          const y1 = firstPos.y + firstCard.offsetHeight / 2;
          const y2 = lastPos.y + lastCard.offsetHeight / 2;

          const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          group.setAttribute('class', 'conn-group');

          // Vertical rail
          const rail = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          rail.setAttribute('x1', x); rail.setAttribute('y1', y1);
          rail.setAttribute('x2', x); rail.setAttribute('y2', y2);
          group.appendChild(rail);

          // Horizontal ticks to each card
          for (const oid of otherIds) {
            const card = document.getElementById('ccard-' + oid);
            if (!card) continue;
            const pos = getOffsetRelativeTo(card, layout);
            const cy = pos.y + card.offsetHeight / 2;

            const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tick.setAttribute('x1', x); tick.setAttribute('y1', cy);
            tick.setAttribute('x2', pos.x); tick.setAttribute('y2', cy);
            group.appendChild(tick);

            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', x); dot.setAttribute('cy', cy); dot.setAttribute('r', '2');
            group.appendChild(dot);
          }

          svg.appendChild(group);
        }
      }

      // Bring hovered group to top and highlight via class
      // (re-appending kills :hover, so we use a class; mouseleave
      //  can miss after re-append, so we clear all on svg mouseleave)
      svg.querySelectorAll('.conn-group').forEach(g => {
        g.addEventListener('mouseenter', () => {
          svg.querySelectorAll('.conn-group.hovered').forEach(el => el.classList.remove('hovered'));
          g.classList.add('hovered');
          svg.appendChild(g);
        });
      });
      svg.addEventListener('mouseleave', () => {
        svg.querySelectorAll('.conn-group.hovered').forEach(el => el.classList.remove('hovered'));
      });
    }

    // Auto-redraw lines when container layout changes (cards appear, resize, etc.)
    const _canvasObserver = new ResizeObserver(() => {
      if (viewMode === 'flow') scheduleDrawLines();
    });
    const _containerEl = document.getElementById('canvasContainer');
    if (_containerEl) _canvasObserver.observe(_containerEl);

    // ── SSE ──
    const es = new EventSource('/events');

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'pipeline_start':
          startTimer();
          document.getElementById('navSub').textContent = msg.pipeline.steps.length + ' steps';
          buildSteps(msg.pipeline.steps);
          buildPages(msg.pipeline.steps);
          // Build skeleton canvas cards and show flow view for multi-page
          {
            const renderers = msg.pipeline.steps.filter(s => s.agentName.startsWith('renderer_'));
            if (renderers.length > 1) {
              buildSkeletonCanvas(renderers);
              document.getElementById('viewToggle').classList.add('visible');
              switchView('flow');
            }
          }
          break;

        case 'agent_start':
          activeAgents.add(msg.agentName);
          stepStartTimes[msg.agentName] = Date.now();
          updateSteps();
          if (msg.agentName.startsWith('renderer_')) {
            updatePageItem(msg.agentName, 'active');
            // Update canvas card to "rendering" state
            const pid = msg.agentName.replace('renderer_', '');
            const ccard = document.getElementById('ccard-' + pid);
            if (ccard) { ccard.className = ccard.className.replace('skeleton', 'rendering'); }
          }
          break;

        case 'agent_complete': {
          activeAgents.delete(msg.agentName);
          completedAgents.add(msg.agentName);
          updateSteps();
          if (msg.agentName.startsWith('renderer_') || msg.agentName.startsWith('validator_')) updatePageItem(msg.agentName, 'done');
          // Show duration on the phase step
          const dur = msg.result?.durationMs;
          if (dur) {
            for (const p of pipelineSteps) {
              if (p.agents.includes(msg.agentName) && p.agents.every(a => completedAgents.has(a))) {
                const durEl = document.getElementById('sdur-' + p.id);
                // Sum durations of all agents in this phase
                const totalMs = p.agents.reduce((sum, a) => {
                  const st = stepStartTimes[a];
                  return Math.max(sum, st ? Date.now() - st : 0);
                }, 0);
                if (durEl) durEl.textContent = (totalMs / 1000).toFixed(1) + 's';
              }
            }
          }
          break;
        }

        case 'design_tokens':
          pestoCss = msg.css;
          break;

        case 'agent_chunk':
          // Stream architect spec into the planning overlay
          if (msg.agentName === 'architect') {
            architectBuffer += msg.chunk;
            updatePlanningView(architectBuffer);
            break;
          }
          if (msg.agentName === 'renderer' || msg.agentName.startsWith('renderer_')) {
            // Hide planning overlay when rendering starts (may already be hidden if canvas is showing)
            document.getElementById('planningOverlay').classList.add('hidden');

            if (!streamingAgent) streamingAgent = msg.agentName;
            if (msg.agentName !== streamingAgent) break;
            rendererBuffer += msg.chunk;
            tryStreamBody();
          }
          break;

        case 'agent_artifact':
          // Progressive page delivery: show each page as its renderer finishes
          if (msg.agentName.startsWith('renderer_')) {
            const pageId = msg.artifactKey.replace('page_', '');
            if (!resultPages) resultPages = {};
            resultPages[pageId] = msg.artifact;
            // Update canvas card with real thumbnail
            updateCanvasCardThumb(pageId, msg.artifact);
            // Add page tab so user can switch to it
            addOrUpdatePageTab(pageId);
            // Update side nav
            updatePageItem('renderer_' + pageId, 'done');
          }
          break;

        case 'pipeline_complete':
          stopTimer();
          pipelineSteps.forEach(p => p.agents.forEach(a => completedAgents.add(a)));
          updateSteps();
          document.getElementById('navSub').textContent = 'Complete';
          const tokens = msg.result?.meta?.tokenUsage;
          if (tokens) {
            document.getElementById('summary').innerHTML =
              '<div style="font-size:10px;color:var(--sh-text-tertiary)">' + (tokens.input + tokens.output).toLocaleString() + ' tokens</div>';
          }
          // Show collapse button and auto-collapse after 2s
          showCollapseBtn();
          setTimeout(collapseNav, 2000);
          break;

        case 'result':
          // Clean up any in-progress state (handles both live generation and SSE replay on reload)
          document.getElementById('planningOverlay').classList.add('hidden');
          stopTimer();
          document.getElementById('navSub').textContent = 'Complete';
          showCollapseBtn();

          // Flush any remaining streamed content, then replace with final canonical HTML
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          flushChunks();
          try { if (iframeDocOpened) iframe.contentDocument.close(); } catch (e) {}
          iframe.srcdoc = msg.result.html;

          if (msg.result.pages && Object.keys(msg.result.pages).length > 1) {
            resultPages = msg.result.pages;
            pageSpecs = msg.result.data?.pageSpecs || null;

            const tabs = document.getElementById('page-tabs');
            tabs.innerHTML = '';
            tabs.classList.add('visible');
            let first = true;
            for (const pageId of Object.keys(resultPages)) {
              const btn = document.createElement('button');
              btn.className = 'page-tab' + (first ? ' active' : '');
              btn.textContent = pageId;
              btn.onclick = () => switchPage(pageId);
              tabs.appendChild(btn);
              first = false;
            }
            // Make page list items clickable
            document.querySelectorAll('.page-item').forEach(item => {
              item.style.cursor = 'pointer';
              item.onclick = () => switchPage(item.id.replace('pitem-', ''));
            });

            // Show view toggle and build canvas
            document.getElementById('viewToggle').classList.add('visible');
            buildCanvas(resultPages, pageSpecs);
          }

          // Extract app name from title
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const title = doc.querySelector('title')?.textContent;
            if (title) document.getElementById('navTitle').textContent = title;
          } catch (e) {}
          break;

        case 'error':
          document.getElementById('navSub').textContent = 'Error: ' + (msg.error || '').slice(0, 60);
          document.getElementById('navSub').style.color = '#f87171';
          break;
      }
    };
  </script>
</body>
</html>`;

program
  .command("preview-shell")
  .description("Preview the live app shell with mock data (no LLM calls)")
  .option("-p, --port <port>", "Port", "3200")
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    const { sendEvent } = startLivePreview(port);

    // Send mock events after a brief delay for browser to connect
    setTimeout(() => {
      const send = (data: unknown) => sendEvent((data as any).type, data);

      send({ type: "pipeline_start", steps: [
        { agentName: "architect", description: "Design the UX spec" },
        { agentName: "shell_renderer", description: "Build shared nav/footer" },
        { agentName: "renderer_dashboard", description: "Renders Dashboard" },
        { agentName: "renderer_settings", description: "Renders Settings" },
        { agentName: "renderer_profile", description: "Renders Profile" },
        { agentName: "validator_dashboard", description: "Validate Dashboard" },
        { agentName: "validator_settings", description: "Validate Settings" },
        { agentName: "validator_profile", description: "Validate Profile" },
      ]});

      const delays: [number, unknown][] = [
        [800, { type: "agent_start", agentName: "architect" }],
        [3000, { type: "agent_done", agentName: "architect", duration: 2.2 }],
        [3300, { type: "agent_start", agentName: "shell_renderer" }],
        [4800, { type: "agent_done", agentName: "shell_renderer", duration: 1.5 }],
        [5000, { type: "agent_start", agentName: "renderer_dashboard" }],
        [5000, { type: "agent_start", agentName: "renderer_settings" }],
        [5000, { type: "agent_start", agentName: "renderer_profile" }],
        [8000, { type: "agent_done", agentName: "renderer_dashboard", duration: 3.0 }],
        [10000, { type: "agent_done", agentName: "renderer_settings", duration: 5.0 }],
        [12000, { type: "agent_done", agentName: "renderer_profile", duration: 7.0 }],
        [12500, { type: "agent_start", agentName: "validator_dashboard" }],
        [12500, { type: "agent_start", agentName: "validator_settings" }],
        [12500, { type: "agent_start", agentName: "validator_profile" }],
        [13000, { type: "agent_done", agentName: "validator_dashboard", duration: 0.5 }],
        [13200, { type: "agent_done", agentName: "validator_settings", duration: 0.7 }],
        [13400, { type: "agent_done", agentName: "validator_profile", duration: 0.9 }],
        [14000, { type: "result", result: {
          html: "<html><body><h1>Mock Result</h1></body></html>",
          pages: {
            dashboard: "<!DOCTYPE html><html><head><title>Dashboard</title></head><body style='font-family:Inter,sans-serif;padding:48px'><h1>Dashboard</h1><p>Mock preview page</p></body></html>",
            settings: "<!DOCTYPE html><html><head><title>Settings</title></head><body style='font-family:Inter,sans-serif;padding:48px'><h1>Settings</h1><p>Mock preview page</p></body></html>",
            profile: "<!DOCTYPE html><html><head><title>Profile</title></head><body style='font-family:Inter,sans-serif;padding:48px'><h1>Profile</h1><p>Mock preview page</p></body></html>",
          },
          usage: { input: 12450, output: 8320 },
        }}],
      ];

      for (const [delay, event] of delays) {
        setTimeout(() => send(event), delay);
      }
    }, 800);

    console.log("   Mock events will simulate a full pipeline run.");
    console.log("   Press Ctrl+C to stop.\n");
  });

program.parse();
