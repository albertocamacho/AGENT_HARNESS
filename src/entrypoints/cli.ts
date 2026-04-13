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
            case "status":
              console.log(`  → ${event.message}`);
              break;
            case "pipeline_start":
              console.log(
                `\n▶ Pipeline: ${event.pipeline.steps.length} steps planned`
              );
              break;
            case "agent_start":
              break;
            case "agent_complete":
              break;
            case "pipeline_complete":
              console.log(
                `\n✓ Complete in ${(event.result.meta.durationMs / 1000).toFixed(1)}s`
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
      width: 240px; flex-shrink: 0;
      background: var(--sh-bg); color: var(--sh-text-secondary);
      display: flex; flex-direction: column;
      border-right: 1px solid var(--sh-border);
      font-size: 13px;
      transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
    }
    .sidenav-header {
      padding: 16px 16px 12px;
      border-bottom: 1px solid var(--sh-border-subtle);
      display: flex; align-items: flex-start; gap: 10px;
    }
    .sidenav-header-info {
      min-width: 0; flex: 1;
      transition: opacity 200ms ease;
    }
    .sidenav-title {
      font-size: 12px; font-weight: 600; color: var(--sh-text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-bottom: 2px; letter-spacing: -0.01em;
    }
    .sidenav-sub { font-size: 11px; color: var(--sh-text-tertiary); white-space: nowrap; }

    .sidenav-body { flex: 1; overflow-y: auto; padding: 12px 0; transition: padding 300ms cubic-bezier(0.4, 0, 0.2, 1); }
    .sidenav-body::-webkit-scrollbar { width: 3px; }
    .sidenav-body::-webkit-scrollbar-track { background: transparent; }
    .sidenav-body::-webkit-scrollbar-thumb { background: var(--sh-border); border-radius: 3px; }

    .sidenav-section { padding: 0 16px; margin-bottom: 20px; transition: margin 300ms cubic-bezier(0.4, 0, 0.2, 1); }
    .sidenav-section-label {
      font-size: 9px; font-weight: 600; color: var(--sh-text-muted);
      text-transform: uppercase; letter-spacing: 0.1em;
      margin-bottom: 10px; white-space: nowrap;
      transition: opacity 200ms ease;
    }

    /* Steps — track column is 16px wide, dot centered at 8px from section left */
    .steps { display: flex; flex-direction: column; gap: 0; position: relative; }

    .step-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 0; position: relative;
    }
    .step-track {
      display: flex; flex-direction: column; align-items: center;
      width: 16px; flex-shrink: 0; align-self: stretch;
    }
    .step-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--sh-bg-raised); border: 1.5px solid var(--sh-border);
      transition: all var(--sh-transition); flex-shrink: 0; position: relative;
      margin-top: 3px; z-index: 1;
    }
    /* Line stretches from below dot to bottom of row, bridging to next dot */
    .step-line {
      width: 1.5px; flex: 1;
      background: var(--sh-border-subtle);
      transition: background var(--sh-transition);
    }
    .step-row.done .step-line { background: var(--sh-accent); }
    .step-row.active .step-line { background: var(--sh-working); }
    .step-row.active .step-dot {
      background: var(--sh-working); border-color: var(--sh-working);
      box-shadow: 0 0 0 3px var(--sh-working-soft);
    }
    .step-row.active .step-dot::after {
      content: ''; position: absolute; inset: 0px; border-radius: 50%;
      background: var(--sh-working); animation: pulse 1.5s infinite;
    }
    .step-row.done .step-dot { background: var(--sh-accent); border-color: var(--sh-accent); }
    .step-info { padding: 0 0 12px; min-width: 0; transition: opacity 200ms ease; }
    .step-name {
      font-size: 11px; color: var(--sh-text-tertiary);
      transition: color var(--sh-transition);
      line-height: 1.2; white-space: nowrap;
    }
    .step-row.active .step-name { color: #fbbf24; font-weight: 500; }
    .step-row.done .step-name { color: var(--sh-text-secondary); }
    .step-duration {
      font-size: 10px; color: var(--sh-text-muted);
      margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .step-row.done .step-duration { color: var(--sh-text-tertiary); }

    /* Pages — icon column is 16px wide, centered at 8px to align with step dots */
    .page-list { display: flex; flex-direction: column; gap: 1px; }
    .page-item {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 0; border-radius: var(--sh-radius-sm);
      background: transparent;
      transition: all var(--sh-transition); cursor: default;
    }
    .page-item:hover { background: var(--sh-bg-raised); }
    .page-status {
      width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .page-status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--sh-border); transition: all var(--sh-transition);
    }
    .page-item.active .page-status-dot { background: var(--sh-working); box-shadow: 0 0 0 3px var(--sh-working-soft); }
    .page-item.done .page-status-dot { display: none; }
    .page-item.done .page-status svg { display: block; }
    .page-status svg { display: none; width: 14px; height: 14px; }
    .page-name {
      font-size: 11px; color: var(--sh-text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: color var(--sh-transition), opacity 200ms ease;
    }
    .page-item.active .page-name { color: #fde68a; }
    .page-item.done .page-name { color: var(--sh-text-secondary); }

    /* Footer */
    .sidenav-footer {
      padding: 12px 16px;
      border-top: 1px solid var(--sh-border-subtle);
      display: flex; justify-content: space-between; align-items: flex-end;
      transition: padding 300ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .timer {
      font-size: 20px; font-weight: 600; color: var(--sh-text-muted);
      font-variant-numeric: tabular-nums; letter-spacing: -0.03em;
      line-height: 1;
      transition: color 300ms, transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
      transform-origin: left bottom;
    }
    .timer.running { color: var(--sh-text-secondary); }
    .timer.done { color: var(--sh-accent); }
    .timer-label {
      font-size: 9px; color: var(--sh-text-muted); margin-top: 2px;
      text-transform: uppercase; letter-spacing: 0.06em;
      white-space: nowrap; transition: opacity 200ms ease;
    }
    .token-summary {
      font-size: 10px; color: var(--sh-text-muted); text-align: right;
      font-variant-numeric: tabular-nums; white-space: nowrap;
      transition: opacity 200ms ease;
    }

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

    /* ── Collapse toggle — 16px wide to align with step track dots ── */
    .collapse-btn {
      display: inline-flex;
      width: 16px; height: 16px;
      background: none; border: 1px solid var(--sh-border); border-radius: 4px;
      color: var(--sh-text-muted); font-size: 10px; line-height: 1;
      cursor: pointer; transition: color 150ms, border-color 150ms, background 150ms;
      align-items: center; justify-content: center; flex-shrink: 0;
      margin-top: 1px;
    }
    .collapse-btn:hover { background: var(--sh-bg-hover); color: var(--sh-text-primary); border-color: var(--sh-text-muted); }

    /* ── Collapsed state: fade text, keep items pinned ── */
    .sidenav.collapsed { width: 48px; }
    .sidenav.collapsed .sidenav-header-info { opacity: 0; pointer-events: none; }
    .sidenav.collapsed .sidenav-section-label { opacity: 0; pointer-events: none; }
    .sidenav.collapsed .step-info { opacity: 0; pointer-events: none; }
    .sidenav.collapsed .page-name { opacity: 0; pointer-events: none; }
    .sidenav.collapsed .timer { transform: scale(0.55); }
    .sidenav.collapsed .timer-label { opacity: 0; pointer-events: none; }
    .sidenav.collapsed .token-summary { opacity: 0; pointer-events: none; }

    /* ── Unified view (IA diagram → flow canvas) ── */
    .unified-view {
      position: absolute; inset: 0; z-index: 5;
      background: var(--sh-bg-sunken);
      background-image: radial-gradient(circle, var(--sh-border-subtle) 1px, transparent 1px);
      background-size: 24px 24px;
      display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
      padding: 48px 40px;
      overflow: auto;
      transition: opacity 500ms ease-out;
    }
    .unified-view.hidden { opacity: 0; pointer-events: none; }
    .unified-header {
      font-size: 10px; font-weight: 600; color: var(--sh-text-muted);
      text-transform: uppercase; letter-spacing: 0.12em;
      margin-bottom: 32px;
      transition: opacity 400ms ease;
    }
    .unified-layout { position: relative; margin: auto; }

    /* Always horizontal flow: landing left, children stacked right */
    .unified-container {
      display: flex; flex-direction: row; align-items: flex-start; gap: 80px;
    }
    .unified-tier { display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .unified-tier.children { gap: 24px; }

    /* ── Unified node ── */
    .unified-node {
      width: 280px;
      background: var(--sh-bg); border: 1px solid var(--sh-border); border-radius: var(--sh-radius);
      overflow: hidden;
      animation: planFade 400ms ease-out;
      transition: border-color 300ms;
    }
    .unified-node.landing { border-color: var(--sh-accent); }
    .unified-node.rendering { border-color: var(--sh-working); }
    .unified-node.ready { border-color: var(--sh-accent); cursor: pointer; }
    .unified-node.ready:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }

    /* Thumbnail area: collapsed in IA mode, grows for rendering/ready */
    .unified-thumb {
      width: 100%; height: 0; overflow: hidden;
      position: relative; background: #F9F8F7;
      transition: height 500ms cubic-bezier(0.4,0,0.2,1);
    }
    .unified-node.rendering .unified-thumb { height: 180px; }
    .unified-node.ready .unified-thumb { height: 180px; }
    .unified-thumb iframe {
      width: 1400px; height: 900px; border: none;
      transform: scale(0.2); transform-origin: top left;
      pointer-events: none;
    }
    .unified-node.rendering .unified-thumb::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 25%, var(--sh-working-soft) 50%, transparent 75%);
      background-size: 200% 100%;
      animation: shimmer 1.8s ease-in-out infinite;
    }
    .unified-node.ready .unified-thumb::after { display: none; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* Node header */
    .unified-node-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--sh-border-subtle);
      display: flex; align-items: center; gap: 6px;
    }
    .unified-node-title {
      font-size: 12px; font-weight: 600; color: var(--sh-text-primary);
      letter-spacing: -0.01em;
    }
    .unified-node-badge {
      display: inline-block; padding: 2px 7px;
      background: var(--sh-accent-soft); color: var(--sh-accent);
      font-size: 9px; font-weight: 600; border-radius: 3px;
      text-transform: uppercase; letter-spacing: 0.05em;
    }

    /* Sections list: visible in IA, collapses when rendering */
    .unified-sections {
      padding: 8px 14px; max-height: 300px; opacity: 1;
      transition: max-height 500ms ease, opacity 400ms ease, padding 400ms ease;
      overflow: hidden;
    }
    .unified-node.rendering .unified-sections,
    .unified-node.ready .unified-sections {
      max-height: 0; opacity: 0; padding: 0 14px;
    }
    .unified-section-item {
      padding: 4px 0; font-size: 11px; color: var(--sh-text-tertiary);
      line-height: 1.4; display: flex; align-items: baseline; gap: 6px;
      animation: planFade 300ms ease-out;
    }
    .unified-section-item::before {
      content: ''; display: inline-block; width: 4px; height: 4px; min-width: 4px;
      background: var(--sh-border); border-radius: 1px; margin-top: 4px;
    }
    .unified-section-name { font-weight: 500; color: var(--sh-text-secondary); }
    .unified-section-detail {
      font-size: 10px; color: var(--sh-text-muted); line-height: 1.4;
      margin-top: 1px; padding-left: 10px;
      display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
    }
    .unified-shimmer .unified-sections::after {
      content: ''; display: block; height: 8px; width: 60%;
      background: linear-gradient(90deg, transparent 25%, var(--sh-bg-hover) 50%, transparent 75%);
      background-size: 200% 100%; border-radius: 3px;
      animation: shimmer 1.8s ease-in-out infinite; margin-top: 4px;
    }

    /* Page description shown below header */
    .unified-node-desc {
      padding: 6px 14px 2px; font-size: 10px; color: var(--sh-text-muted);
      line-height: 1.5;
      transition: max-height 500ms ease, opacity 400ms ease, padding 400ms ease;
      max-height: 60px; opacity: 1; overflow: hidden;
    }
    .unified-node.rendering .unified-node-desc,
    .unified-node.ready .unified-node-desc {
      max-height: 0; opacity: 0; padding: 0 14px;
    }

    /* Rendering progress overlay inside thumb */
    .unified-render-status {
      position: absolute; bottom: 0; left: 0; right: 0;
      padding: 8px 12px;
      background: linear-gradient(transparent, rgba(0,0,0,0.7));
      font-size: 10px; color: rgba(255,255,255,0.8);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: opacity 300ms ease;
    }
    .unified-node.ready .unified-render-status { opacity: 0; }

    /* Node status label (shown after ready) */
    .unified-node-status {
      padding: 0 14px 10px; font-size: 11px; color: var(--sh-text-tertiary);
      max-height: 0; opacity: 0; overflow: hidden;
      transition: max-height 400ms ease, opacity 400ms ease, padding 400ms ease;
    }
    .unified-node.ready .unified-node-status { max-height: 40px; opacity: 1; padding: 6px 14px 10px; }

    /* ── View toggle ── */
    .view-toggle {
      display: none;
      background: var(--sh-bg); border-bottom: 1px solid var(--sh-border);
      padding: 8px 16px; gap: 4px; flex-shrink: 0;
      position: relative; z-index: 6;
    }
    .view-toggle.visible { display: flex; }
    .view-btn {
      padding: 5px 14px; font: 500 11px "Inter", system-ui, sans-serif;
      background: none; border: 1px solid transparent; border-radius: var(--sh-radius-sm);
      color: var(--sh-text-tertiary); cursor: pointer; transition: all 150ms;
    }
    .view-btn:hover { color: var(--sh-text-primary); }
    .view-btn.active {
      background: var(--sh-bg-raised); border-color: var(--sh-border);
      color: var(--sh-text-primary);
    }

    /* ── Flow SVG connections ── */
    .unified-svg {
      position: absolute; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; overflow: visible;
    }
    .unified-svg path, .unified-svg line {
      fill: none; stroke: var(--sh-text-muted); stroke-width: 1.5;
      stroke-linejoin: round; stroke-linecap: round;
      transition: stroke 200ms, stroke-width 200ms;
    }
    .unified-svg .conn-group path.draw-in {
      animation: drawLine 800ms ease-out forwards;
    }
    @keyframes drawLine {
      from { stroke-dashoffset: var(--path-len); opacity: 0.3; }
      to { stroke-dashoffset: 0; opacity: 1; }
    }
    .unified-svg .conn-group { opacity: 0; animation: fadeInGroup 500ms ease-out forwards; }
    @keyframes fadeInGroup { from { opacity: 0; } to { opacity: 1; } }
    .unified-svg polygon {
      fill: var(--sh-text-muted); transition: fill 200ms;
    }
    .unified-svg .conn-group { pointer-events: auto; cursor: default; }
    .unified-svg .conn-group:hover path,
    .unified-svg .conn-group.hovered path { stroke: var(--sh-accent); stroke-width: 2; }
    .unified-svg .conn-group:hover polygon,
    .unified-svg .conn-group.hovered polygon { fill: var(--sh-accent); }
    .unified-svg .conn-group:hover .conn-label rect,
    .unified-svg .conn-group.hovered .conn-label rect { fill: var(--sh-accent); }
    .unified-svg .conn-group:hover .conn-label text,
    .unified-svg .conn-group.hovered .conn-label text { fill: var(--sh-bg); }
    .unified-svg .conn-label text {
      font-family: "Inter", system-ui, sans-serif;
      font-size: 9px; font-weight: 600;
      fill: var(--sh-text-muted);
      text-anchor: middle; dominant-baseline: central;
      letter-spacing: 0.04em;
    }
    .unified-svg .conn-label rect {
      fill: var(--sh-bg-raised); rx: 3; ry: 3; transition: fill 200ms;
    }

    @keyframes planFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  </style>
</head>
<body>
  <nav class="sidenav" id="sidenav">
    <div class="sidenav-header">
      <button class="collapse-btn" id="collapseBtn" onclick="toggleNav()" title="Toggle sidebar">&lsaquo;</button>
      <div class="sidenav-header-info">
        <div class="sidenav-title" id="navTitle">Generating...</div>
        <div class="sidenav-sub" id="navSub">Starting pipeline</div>
      </div>
    </div>
    <div class="sidenav-body">
      <div class="sidenav-section">
        <div class="sidenav-section-label">Pipeline</div>
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
      <div class="token-summary" id="summary"></div>
    </div>
  </nav>
  <div class="main" style="position:relative">
    <div class="unified-view" id="unifiedView">
      <div class="unified-header" id="unifiedHeader">Analyzing</div>
      <div class="unified-layout" id="unifiedLayout">
        <div class="unified-container" id="unifiedContainer"></div>
        <svg class="unified-svg" id="unifiedSvg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
    <div class="view-toggle" id="viewToggle">
      <button class="view-btn active" id="viewProto" onclick="switchView('prototype')">Prototype</button>
      <button class="view-btn" id="viewFlow" onclick="switchView('flow')">Flow</button>
    </div>
    <div class="page-tabs" id="page-tabs"></div>
    <div id="prototypeView" style="display:none;flex:1;min-height:0;">
      <iframe id="preview" style="flex:1;"></iframe>
    </div>
  </div>
  <script>
    let pestoCss = '';
    let architectBuffer = '';
    let planningDebounce = null;
    let iaPages = {};       // { pageId: { title, isLanding, sections: [] } }
    let iaBuilt = false;    // whether the initial unified nodes have been rendered
    let inFlowMode = false; // whether we've transitioned to horizontal flow layout
    let rendererBuffer = '';
    let iframeDocOpened = false;
    let pendingChunks = '';
    let rafId = 0;
    let streamingAgent = '';
    let rendererBuffers = {};  // per-page renderer chunk buffers
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

    const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="' + 'var(--sh-accent)' + '" opacity="0.15"/><path d="M5 8.5L7 10.5L11 6" stroke="var(--sh-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const SPINNER_SVG = '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="var(--sh-working)" stroke-width="1.5" opacity="0.2"/><path d="M8 2a6 6 0 0 1 6 6" stroke="var(--sh-working)" stroke-width="1.5" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite"/></path></svg>';

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
        if (agents.some(a => a === 'architect' || a === 'shell')) label = 'Design';
        else if (agents.some(a => a.startsWith('renderer'))) label = 'Render';
        else if (agents.some(a => a.startsWith('validator'))) label = 'Validate';
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
        // Use title from iaPages if available, otherwise format the ID
        const title = iaPages[pageId] ? iaPages[pageId].title : pageId.replace(/-/g, ' ');
        const item = document.createElement('div');
        item.className = 'page-item';
        item.id = 'pitem-' + pageId;
        item.innerHTML =
          '<div class="page-status"><div class="page-status-dot"></div>' + CHECK_SVG + '</div>' +
          '<span class="page-name">' + title + '</span>';
        container.appendChild(item);
      }
    }

    function updatePageItem(agentName, state) {
      const pageId = agentName.replace('renderer_', '').replace('validator_', '');
      const item = document.getElementById('pitem-' + pageId);
      if (item) {
        item.className = 'page-item ' + state;
      }
    }

    // ── Unified view (IA → flow) ──

    /** Build the unified IA diagram from complexity status event */
    function buildIAFromStatus(detail) {
      if (!detail || detail.kind !== 'complexity') return;
      const header = document.getElementById('unifiedHeader');
      header.textContent = detail.tier === 'multi'
        ? 'Information Architecture — ' + detail.pages.length + ' pages'
        : 'Information Architecture';

      iaPages = {};
      for (const p of detail.pages) {
        iaPages[p.id] = { title: p.title, description: p.description || '', isLanding: !!p.isLanding, sections: [], sectionDetails: {} };
      }
      renderUnified();
      iaBuilt = true;
    }

    /** Render unified nodes in horizontal flow layout */
    function renderUnified() {
      const container = document.getElementById('unifiedContainer');
      container.innerHTML = '';

      const entries = Object.entries(iaPages);
      if (entries.length === 0) return;

      const landing = entries.find(([, v]) => v.isLanding);
      const others = entries.filter(([, v]) => !v.isLanding);

      // Landing node on the left
      if (landing) {
        const landingTier = document.createElement('div');
        landingTier.className = 'unified-tier';
        landingTier.appendChild(createUnifiedNode(landing[0], landing[1], true));
        container.appendChild(landingTier);
      }

      // Children stacked on the right
      if (others.length > 0) {
        const childTier = document.createElement('div');
        childTier.className = 'unified-tier children';
        for (const [id, page] of others) {
          childTier.appendChild(createUnifiedNode(id, page, false));
        }
        container.appendChild(childTier);
      }

      // Draw SVG arrows after layout settles
      if (others.length > 0) {
        requestAnimationFrame(() => drawFlowLines());
      }
    }

    function createUnifiedNode(id, page, isLanding) {
      const node = document.createElement('div');
      node.className = 'unified-node unified-shimmer' + (isLanding ? ' landing' : '');
      node.id = 'unode-' + id;

      // Thumbnail area (collapsed initially, grows via CSS when .rendering/.ready)
      const thumb = document.createElement('div');
      thumb.className = 'unified-thumb';
      thumb.id = 'uthumb-' + id;
      // Render status overlay (visible during rendering)
      const renderStatus = document.createElement('div');
      renderStatus.className = 'unified-render-status';
      renderStatus.id = 'urender-' + id;
      renderStatus.textContent = 'Waiting...';
      thumb.appendChild(renderStatus);
      node.appendChild(thumb);

      // Header
      const header = document.createElement('div');
      header.className = 'unified-node-header';
      header.innerHTML = '<span class="unified-node-title">' + page.title + '</span>' +
        (isLanding ? '<span class="unified-node-badge">entry</span>' : '');
      node.appendChild(header);

      // Description (from complexity detection)
      if (page.description) {
        const desc = document.createElement('div');
        desc.className = 'unified-node-desc';
        desc.textContent = page.description;
        node.appendChild(desc);
      }

      // Sections list (visible in IA, collapses when rendering)
      const sectionsEl = document.createElement('div');
      sectionsEl.className = 'unified-sections';
      sectionsEl.id = 'usections-' + id;
      node.appendChild(sectionsEl);

      // Status label (hidden until ready)
      const status = document.createElement('div');
      status.className = 'unified-node-status';
      status.id = 'ustatus-' + id;
      status.textContent = 'Click to preview';
      node.appendChild(status);

      return node;
    }

    /** Transition nodes from IA sections to rendering thumbnails */
    function transitionToRendering() {
      if (inFlowMode) return;
      inFlowMode = true;

      document.getElementById('unifiedHeader').textContent = 'Rendering';

      // Mark all nodes as rendering (thumbnail grows, sections collapse)
      for (const id of Object.keys(iaPages)) {
        const node = document.getElementById('unode-' + id);
        if (node) {
          node.classList.remove('unified-shimmer');
          node.classList.add('rendering');
        }
      }

      // Redraw lines after nodes resize
      setTimeout(() => drawFlowLines(), 600);

      // Show view toggle
      document.getElementById('viewToggle').classList.add('visible');
    }

    /** Update a node with rendered page HTML */
    function updateNodeThumb(pageId, html) {
      const node = document.getElementById('unode-' + pageId);
      if (!node) return;

      node.classList.remove('rendering');
      node.classList.add('ready');

      const thumb = document.getElementById('uthumb-' + pageId);
      if (thumb) {
        thumb.innerHTML = '';
        const thumbIframe = document.createElement('iframe');
        thumbIframe.srcdoc = html;
        thumbIframe.setAttribute('loading', 'lazy');
        thumb.appendChild(thumbIframe);
      }

      node.style.cursor = 'pointer';
      node.onclick = () => { switchView('prototype'); switchPage(pageId); };

      // Redraw flow lines
      if (inFlowMode) scheduleDrawLines();
    }

    // ── Unified SVG line drawing ──

    let drawLinesRAF = 0;
    function scheduleDrawLines() {
      if (drawLinesRAF) cancelAnimationFrame(drawLinesRAF);
      drawLinesRAF = requestAnimationFrame(() => { drawLinesRAF = 0; drawFlowLines(); });
    }

    function getOffsetRelativeTo(el, ancestor) {
      let x = 0, y = 0, current = el;
      while (current && current !== ancestor) {
        x += current.offsetLeft; y += current.offsetTop;
        current = current.offsetParent;
      }
      return { x, y };
    }

    /** Draw horizontal elbow-pipe connections (flow mode) */
    function drawFlowLines() {
      const svg = document.getElementById('unifiedSvg');
      const layout = document.getElementById('unifiedLayout');
      if (!svg || !layout) return;

      const allNodes = layout.querySelectorAll('.unified-node');
      if (allNodes.length < 2) return;

      svg.innerHTML = '';
      if (!layout.offsetWidth) return;

      const w = layout.offsetWidth;
      const h = layout.offsetHeight;
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      // Find landing and other nodes
      const landingNode = layout.querySelector('.unified-node.landing');
      if (!landingNode || landingNode.offsetWidth === 0) return;
      const landingId = landingNode.id.replace('unode-', '');

      const otherNodes = [...allNodes].filter(n => !n.classList.contains('landing'));

      for (const otherNode of otherNodes) {
        if (otherNode.offsetWidth === 0) continue;

        const fromPos = getOffsetRelativeTo(landingNode, layout);
        const toPos = getOffsetRelativeTo(otherNode, layout);

        const x1 = fromPos.x + landingNode.offsetWidth;
        const y1 = fromPos.y + landingNode.offsetHeight / 2;
        const x2 = toPos.x;
        const y2 = toPos.y + otherNode.offsetHeight / 2;
        const midX = (x1 + x2) / 2;

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'conn-group');

        // Elbow pipe path with rounded corners
        const r = Math.min(12, Math.abs(y2 - y1) / 2, Math.abs(midX - x1) / 2);
        let d;
        if (Math.abs(y2 - y1) < 1) {
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
        path.classList.add('draw-in');
        group.appendChild(path);

        // Measure path length for draw-in animation after append
        requestAnimationFrame(() => {
          const len = path.getTotalLength();
          path.style.strokeDasharray = len;
          path.style.setProperty('--path-len', len);
        });

        // Hit area
        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('d', d);
        hitArea.setAttribute('stroke', 'transparent');
        hitArea.setAttribute('stroke-width', '16');
        hitArea.setAttribute('fill', 'none');
        group.appendChild(hitArea);

        // Arrows
        const as = 5;
        const arrowEnd = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowEnd.setAttribute('points', x2+','+y2+' '+(x2-as*2)+','+(y2-as)+' '+(x2-as*2)+','+(y2+as));
        group.appendChild(arrowEnd);

        const arrowStart = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowStart.setAttribute('points', x1+','+y1+' '+(x1+as*2)+','+(y1-as)+' '+(x1+as*2)+','+(y1+as));
        group.appendChild(arrowStart);

        // "nav" label
        const labelX = midX;
        const labelY = (y1 + y2) / 2;
        const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelGroup.setAttribute('class', 'conn-label');
        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', labelX - 12); labelBg.setAttribute('y', labelY - 7);
        labelBg.setAttribute('width', '24'); labelBg.setAttribute('height', '14');
        labelGroup.appendChild(labelBg);
        const labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        labelText.setAttribute('x', labelX); labelText.setAttribute('y', labelY);
        labelText.textContent = 'nav';
        labelGroup.appendChild(labelText);
        group.appendChild(labelGroup);

        svg.appendChild(group);
      }
    }

    /** Show live rendering progress in a card's thumb overlay */
    function updateRenderStatus(pageId, buf) {
      const el = document.getElementById('urender-' + pageId);
      if (!el) return;

      // Count meaningful HTML elements to show progress
      const sectionCount = (buf.match(/<(section|article|header|footer|nav|main)/gi) || []).length;
      const headingCount = (buf.match(/<h[1-6]/gi) || []).length;

      // Find the last heading text as current focus
      const headings = [...buf.matchAll(/<h[1-6][^>]*>([^<]+)/gi)];
      const lastHeading = headings.length > 0 ? headings[headings.length - 1][1].trim() : '';

      let status = '';
      if (lastHeading) {
        status = lastHeading;
      } else if (sectionCount > 0) {
        status = sectionCount + ' section' + (sectionCount > 1 ? 's' : '');
      } else if (buf.length > 100) {
        status = 'Writing markup...';
      } else {
        status = 'Starting...';
      }

      if (headingCount > 0 && lastHeading) {
        status = headingCount + ' heading' + (headingCount > 1 ? 's' : '') + ' \u00B7 ' + lastHeading;
      }

      el.textContent = status;
    }

    /** Update IA sections from architect streaming chunks */
    function updatePlanningView(buf) {
      clearTimeout(planningDebounce);
      planningDebounce = setTimeout(() => parseArchitectSections(buf), 150);
    }

    function extractSectionsWithDetails(content) {
      const sections = [];
      const details = {};
      const headerRegex = /^##\\s+(.+)$/gm;
      let hm;
      while ((hm = headerRegex.exec(content)) !== null) {
        const name = hm[1].trim();
        if (name.toLowerCase().startsWith('page:') || name.toLowerCase().startsWith('page-specific')) continue;
        sections.push(name);
        // Grab the first bullet/line after the header as a detail
        const after = content.substring(hm.index + hm[0].length);
        const lines = after.split('\\n').filter(function(l) { return l.trim().length > 0; });
        const detail = lines[0] ? lines[0].trim().replace(/^[-*]\\s*/, '').substring(0, 100) : '';
        if (detail) details[name] = detail;
      }
      return { sections: sections, details: details };
    }

    function parseArchitectSections(buf) {
      if (!iaBuilt) return;

      // Parse per-page spec blocks: <spec id="page-id">...</spec>
      const specBlocks = [...buf.matchAll(/<spec\\s+id=["']([^"']+)["']\\s*>([\\s\\S]*?)(?:<\\/spec>|$)/gi)];

      let changed = false;
      for (const m of specBlocks) {
        const pageId = m[1];
        const content = m[2];
        if (!iaPages[pageId]) continue;

        const result = extractSectionsWithDetails(content);
        if (result.sections.length > iaPages[pageId].sections.length) {
          iaPages[pageId].sections = result.sections;
          iaPages[pageId].sectionDetails = result.details;
          changed = true;
        }
      }

      // Single-page fallback
      if (specBlocks.length === 0) {
        const entries = Object.entries(iaPages);
        if (entries.length === 1) {
          const pageId = entries[0][0];
          const page = entries[0][1];
          const result = extractSectionsWithDetails(buf);
          if (result.sections.length > page.sections.length) {
            iaPages[pageId].sections = result.sections;
            iaPages[pageId].sectionDetails = result.details;
            changed = true;
          }
        }
      }

      if (changed) {
        for (const [id, page] of Object.entries(iaPages)) {
          const sectionsEl = document.getElementById('usections-' + id);
          if (!sectionsEl) continue;
          const existing = sectionsEl.querySelectorAll('.unified-section-item').length;
          for (let i = existing; i < page.sections.length; i++) {
            const sName = page.sections[i];
            const detail = page.sectionDetails[sName] || '';
            const item = document.createElement('div');
            item.className = 'unified-section-item';
            item.innerHTML = '<span class="unified-section-name">' + sName + '</span>' +
              (detail ? '<div class="unified-section-detail">' + detail + '</div>' : '');
            sectionsEl.appendChild(item);
          }
          const node = document.getElementById('unode-' + id);
          if (node && page.sections.length > 0) node.classList.remove('unified-shimmer');
        }

        const totalSections = Object.values(iaPages).reduce((sum, p) => sum + p.sections.length, 0);
        if (totalSections > 0) {
          document.getElementById('unifiedHeader').textContent =
            'Information Architecture — ' + Object.keys(iaPages).length + ' pages, ' + totalSections + ' sections';
        }

        // Redraw arrows since node heights changed
        scheduleDrawLines();
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
    }

    function showCollapseBtn() {
      // collapse button is always visible now, no-op for backward compat
    }

    // ── View switching ──
    let viewMode = 'flow'; // start in flow (unified view is always visible first)
    let pageSpecs = null;

    function switchView(mode) {
      viewMode = mode;
      document.getElementById('prototypeView').style.display = mode === 'prototype' ? 'flex' : 'none';
      document.getElementById('unifiedView').style.display = mode === 'flow' ? 'flex' : 'none';
      document.getElementById('page-tabs').style.display = mode === 'prototype' && resultPages ? '' : 'none';
      document.getElementById('viewProto').classList.toggle('active', mode === 'prototype');
      document.getElementById('viewFlow').classList.toggle('active', mode === 'flow');
      if (mode === 'flow') scheduleDrawLines();
    }

    /** Add or update a page tab for progressive delivery */
    function addOrUpdatePageTab(pageId) {
      const tabs = document.getElementById('page-tabs');
      tabs.classList.add('visible');
      if (document.getElementById('ptab-' + pageId)) return;
      const btn = document.createElement('button');
      btn.className = 'page-tab' + (tabs.children.length === 0 ? ' active' : '');
      btn.id = 'ptab-' + pageId;
      btn.textContent = pageId;
      btn.onclick = () => switchPage(pageId);
      tabs.appendChild(btn);
    }

    // Auto-redraw flow lines when layout changes
    const _resizeObserver = new ResizeObserver(() => {
      if (iaBuilt) scheduleDrawLines();
    });
    const _unifiedEl = document.getElementById('unifiedContainer');
    if (_unifiedEl) _resizeObserver.observe(_unifiedEl);

    // ── SSE ──
    const es = new EventSource('/events');

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'status':
          // Only show short, meaningful messages in the nav subtitle
          if (msg.detail && msg.detail.kind === 'pipeline_plan') break; // skip verbose plan dump
          if (msg.detail && msg.detail.kind === 'complexity') {
            const n = msg.detail.pages ? msg.detail.pages.length : 0;
            document.getElementById('navSub').textContent = n > 1 ? n + ' pages' : 'Single page';
            buildIAFromStatus(msg.detail);
          } else {
            const line = msg.message.split(String.fromCharCode(10))[0];
            document.getElementById('navSub').textContent = line.length > 50 ? line.substring(0, 47) + '...' : line;
          }
          break;

        case 'pipeline_start':
          startTimer();
          document.getElementById('navSub').textContent = msg.pipeline.steps.length + ' steps';
          buildSteps(msg.pipeline.steps);
          buildPages(msg.pipeline.steps);
          break;

        case 'agent_start':
          activeAgents.add(msg.agentName);
          stepStartTimes[msg.agentName] = Date.now();
          updateSteps();
          if (msg.agentName.startsWith('renderer_')) {
            updatePageItem(msg.agentName, 'active');
            // Transition to flow mode when first renderer starts
            if (!inFlowMode) transitionToRendering();
            // Set initial render status
            const rpid = msg.agentName.replace('renderer_', '');
            const rEl = document.getElementById('urender-' + rpid);
            if (rEl) rEl.textContent = 'Generating...';
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
          // Stream architect spec into IA diagram sections
          if (msg.agentName === 'architect') {
            architectBuffer += msg.chunk;
            updatePlanningView(architectBuffer);
            break;
          }
          if (msg.agentName === 'renderer' || msg.agentName.startsWith('renderer_')) {
            // Update per-page render status in the card
            const rpid = msg.agentName.replace('renderer_', '');
            if (!rendererBuffers[rpid]) rendererBuffers[rpid] = '';
            rendererBuffers[rpid] += msg.chunk;
            updateRenderStatus(rpid, rendererBuffers[rpid]);

            // Stream first renderer to iframe
            if (!streamingAgent) streamingAgent = msg.agentName;
            if (msg.agentName !== streamingAgent) break;
            rendererBuffer += msg.chunk;
            tryStreamBody();
          }
          break;

        case 'agent_artifact':
          // Progressive page delivery: update unified node with thumbnail
          if (msg.agentName.startsWith('renderer_')) {
            const pageId = msg.artifactKey.replace('page_', '');
            if (!resultPages) resultPages = {};
            resultPages[pageId] = msg.artifact;
            updateNodeThumb(pageId, msg.artifact);
            addOrUpdatePageTab(pageId);
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
            document.getElementById('summary').textContent = (tokens.input + tokens.output).toLocaleString() + ' tokens';
          }
          // Show collapse button and auto-collapse after 2s
          showCollapseBtn();
          setTimeout(collapseNav, 2000);
          break;

        case 'result':
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

            // Ensure unified view is in flow mode with all thumbnails
            if (!inFlowMode) transitionToRendering();
            for (const [pageId, html] of Object.entries(resultPages)) {
              updateNodeThumb(pageId, html);
            }
            document.getElementById('viewToggle').classList.add('visible');
            document.getElementById('unifiedHeader').textContent = 'Complete — ' + Object.keys(resultPages).length + ' pages';
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

      const mockPages = [
        { id: "dashboard", title: "Dashboard", description: "Overview of key metrics, active projects, and recent activity across all teams", isLanding: true },
        { id: "settings", title: "Settings", description: "Account preferences, notification configuration, integrations, and billing management", isLanding: false },
        { id: "profile", title: "Profile", description: "User profile with activity history, skills, and team membership details", isLanding: false },
      ];

      const mockSteps = [
        { agentName: "architect", phase: 0 },
        { agentName: "shell", phase: 0 },
        { agentName: "renderer_dashboard", phase: 1 },
        { agentName: "renderer_settings", phase: 1 },
        { agentName: "renderer_profile", phase: 1 },
        { agentName: "validator_dashboard", phase: 2 },
        { agentName: "validator_settings", phase: 2 },
        { agentName: "validator_profile", phase: 2 },
      ];

      const mockResult = (agentName: string, durationMs: number) => ({
        agentName, artifactKey: agentName, durationMs, tokenUsage: { input: 1500, output: 1000 },
      });

      const mockPageHtml = (title: string) =>
        `<!DOCTYPE html><html><head><title>${title}</title></head><body style="font-family:Inter,sans-serif;padding:48px"><h1>${title}</h1><p>Mock preview page</p></body></html>`;

      const delays: [number, unknown][] = [
        // Analyzing
        [0, { type: "status", message: "Analyzing request..." }],

        // Complexity detected
        [600, { type: "status", message: "3 pages detected\n  * Dashboard (dashboard)\n    Settings (settings)\n    Profile (profile)", detail: { kind: "complexity", tier: "multi", pages: mockPages } }],

        // Pipeline start
        [800, { type: "pipeline_start", pipeline: { steps: mockSteps } }],
        [800, { type: "status", message: "Pipeline: Phase 0: architect, shell → Phase 1: renderer_dashboard, renderer_settings, renderer_profile → Phase 2: validator_dashboard, validator_settings, validator_profile", detail: { kind: "pipeline_plan", phases: [{ phase: 0, agents: ["architect", "shell"] }, { phase: 1, agents: ["renderer_dashboard", "renderer_settings", "renderer_profile"] }, { phase: 2, agents: ["validator_dashboard", "validator_settings", "validator_profile"] }] } }],

        // Phase 0: architect + shell
        [1000, { type: "status", message: "Designing page structure and content + Building shared navigation and layout shell", detail: { kind: "phase_start", phase: 0, agents: ["architect", "shell"] } }],
        [1000, { type: "agent_start", agentName: "architect", phase: 0 }],
        [1000, { type: "status", message: "Designing page structure and content", detail: { kind: "agent_progress", agentName: "architect", message: "Designing page structure and content" } }],
        [1100, { type: "agent_start", agentName: "shell", phase: 0 }],
        [1100, { type: "status", message: "Building shared navigation and layout shell", detail: { kind: "agent_progress", agentName: "shell", message: "Building shared navigation and layout shell" } }],

        // Mock architect streaming — sections appear progressively in the IA diagram
        [1300, { type: "agent_chunk", agentName: "architect", chunk: '<spec id="dashboard">\n\n## Hero Metrics\n' }],
        [1500, { type: "agent_chunk", agentName: "architect", chunk: '## Active Projects\n' }],
        [1700, { type: "agent_chunk", agentName: "architect", chunk: '## Recent Activity\n## Quick Actions\n</spec>\n' }],
        [1900, { type: "agent_chunk", agentName: "architect", chunk: '<spec id="settings">\n\n## Account Settings\n' }],
        [2100, { type: "agent_chunk", agentName: "architect", chunk: '## Notification Preferences\n## Integrations\n' }],
        [2300, { type: "agent_chunk", agentName: "architect", chunk: '## Billing\n</spec>\n' }],
        [2500, { type: "agent_chunk", agentName: "architect", chunk: '<spec id="profile">\n\n## Profile Header\n' }],
        [2700, { type: "agent_chunk", agentName: "architect", chunk: '## Activity Feed\n## Skills & Expertise\n</spec>' }],

        [3200, { type: "status", message: "Designing page structure and content — done in 2.2s", detail: { kind: "agent_progress", agentName: "architect", message: "done" } }],
        [3200, { type: "agent_complete", agentName: "architect", result: mockResult("architect", 2200) }],
        [3800, { type: "status", message: "Building shared navigation and layout shell — done in 2.7s", detail: { kind: "agent_progress", agentName: "shell", message: "done" } }],
        [3800, { type: "agent_complete", agentName: "shell", result: mockResult("shell", 2700) }],

        // Phase 1: renderers in parallel
        [4000, { type: "status", message: "Rendering 3 pages in parallel", detail: { kind: "phase_start", phase: 1, agents: ["renderer_dashboard", "renderer_settings", "renderer_profile"] } }],
        [4000, { type: "agent_start", agentName: "renderer_dashboard", phase: 1 }],
        [4000, { type: "status", message: "Rendering Dashboard", detail: { kind: "agent_progress", agentName: "renderer_dashboard", message: "Rendering Dashboard" } }],
        [4000, { type: "agent_start", agentName: "renderer_settings", phase: 1 }],
        [4000, { type: "status", message: "Rendering Settings", detail: { kind: "agent_progress", agentName: "renderer_settings", message: "Rendering Settings" } }],
        [4000, { type: "agent_start", agentName: "renderer_profile", phase: 1 }],
        [4000, { type: "status", message: "Rendering Profile", detail: { kind: "agent_progress", agentName: "renderer_profile", message: "Rendering Profile" } }],

        // Mock renderer chunks — show live progress in cards
        [4500, { type: "agent_chunk", agentName: "renderer_dashboard", chunk: '<html><head><title>Dashboard</title></head><body><header>' }],
        [5000, { type: "agent_chunk", agentName: "renderer_dashboard", chunk: '<h1>Dashboard</h1></header><section><h2>Key Metrics</h2>' }],
        [5500, { type: "agent_chunk", agentName: "renderer_dashboard", chunk: '<section><h2>Active Projects</h2>' }],
        [6000, { type: "agent_chunk", agentName: "renderer_dashboard", chunk: '<section><h2>Recent Activity</h2>' }],
        [6500, { type: "agent_chunk", agentName: "renderer_dashboard", chunk: '<section><h2>Quick Actions</h2></section>' }],

        [4800, { type: "agent_chunk", agentName: "renderer_settings", chunk: '<html><head><title>Settings</title></head><body><header>' }],
        [5500, { type: "agent_chunk", agentName: "renderer_settings", chunk: '<h1>Settings</h1></header><section><h2>Account</h2>' }],
        [6500, { type: "agent_chunk", agentName: "renderer_settings", chunk: '<section><h2>Notifications</h2>' }],
        [7500, { type: "agent_chunk", agentName: "renderer_settings", chunk: '<section><h2>Integrations</h2>' }],
        [8500, { type: "agent_chunk", agentName: "renderer_settings", chunk: '<section><h2>Billing</h2></section>' }],

        [5000, { type: "agent_chunk", agentName: "renderer_profile", chunk: '<html><head><title>Profile</title></head><body><header>' }],
        [6000, { type: "agent_chunk", agentName: "renderer_profile", chunk: '<h1>Profile</h1></header><section><h2>Profile Header</h2>' }],
        [7500, { type: "agent_chunk", agentName: "renderer_profile", chunk: '<section><h2>Activity Feed</h2>' }],
        [9000, { type: "agent_chunk", agentName: "renderer_profile", chunk: '<section><h2>Skills & Expertise</h2>' }],
        [10500, { type: "agent_chunk", agentName: "renderer_profile", chunk: '<section><h2>Team Membership</h2></section>' }],

        [7000, { type: "status", message: "Rendering Dashboard — done in 3.0s", detail: { kind: "agent_progress", agentName: "renderer_dashboard", message: "done" } }],
        [7000, { type: "agent_complete", agentName: "renderer_dashboard", result: mockResult("renderer_dashboard", 3000) }],
        [7000, { type: "agent_artifact", agentName: "renderer_dashboard", artifactKey: "page_dashboard", artifact: mockPageHtml("Dashboard") }],

        [9000, { type: "status", message: "Rendering Settings — done in 5.0s", detail: { kind: "agent_progress", agentName: "renderer_settings", message: "done" } }],
        [9000, { type: "agent_complete", agentName: "renderer_settings", result: mockResult("renderer_settings", 5000) }],
        [9000, { type: "agent_artifact", agentName: "renderer_settings", artifactKey: "page_settings", artifact: mockPageHtml("Settings") }],

        [11000, { type: "status", message: "Rendering Profile — done in 7.0s", detail: { kind: "agent_progress", agentName: "renderer_profile", message: "done" } }],
        [11000, { type: "agent_complete", agentName: "renderer_profile", result: mockResult("renderer_profile", 7000) }],
        [11000, { type: "agent_artifact", agentName: "renderer_profile", artifactKey: "page_profile", artifact: mockPageHtml("Profile") }],

        // Phase 2: validators in parallel
        [11500, { type: "status", message: "Validating 3 pages in parallel", detail: { kind: "phase_start", phase: 2, agents: ["validator_dashboard", "validator_settings", "validator_profile"] } }],
        [11500, { type: "agent_start", agentName: "validator_dashboard", phase: 2 }],
        [11500, { type: "status", message: "Validating Dashboard", detail: { kind: "agent_progress", agentName: "validator_dashboard", message: "Validating Dashboard" } }],
        [11500, { type: "agent_start", agentName: "validator_settings", phase: 2 }],
        [11500, { type: "status", message: "Validating Settings", detail: { kind: "agent_progress", agentName: "validator_settings", message: "Validating Settings" } }],
        [11500, { type: "agent_start", agentName: "validator_profile", phase: 2 }],
        [11500, { type: "status", message: "Validating Profile", detail: { kind: "agent_progress", agentName: "validator_profile", message: "Validating Profile" } }],

        [12000, { type: "status", message: "Validating Dashboard — done in 0.5s", detail: { kind: "agent_progress", agentName: "validator_dashboard", message: "done" } }],
        [12000, { type: "agent_complete", agentName: "validator_dashboard", result: mockResult("validator_dashboard", 500) }],
        [12200, { type: "status", message: "Validating Settings — done in 0.7s", detail: { kind: "agent_progress", agentName: "validator_settings", message: "done" } }],
        [12200, { type: "agent_complete", agentName: "validator_settings", result: mockResult("validator_settings", 700) }],
        [12400, { type: "status", message: "Validating Profile — done in 0.9s", detail: { kind: "agent_progress", agentName: "validator_profile", message: "done" } }],
        [12400, { type: "agent_complete", agentName: "validator_profile", result: mockResult("validator_profile", 900) }],

        // Pipeline complete
        [13000, { type: "pipeline_complete", result: {
          id: "mock-run",
          html: mockPageHtml("Dashboard"),
          pages: { dashboard: mockPageHtml("Dashboard"), settings: mockPageHtml("Settings"), profile: mockPageHtml("Profile") },
          meta: { durationMs: 13000, agentSteps: [], tokenUsage: { input: 12450, output: 8320 } },
          data: { pageSpecs: mockPages },
        }}],
        [13000, { type: "result", result: {
          html: mockPageHtml("Dashboard"),
          pages: { dashboard: mockPageHtml("Dashboard"), settings: mockPageHtml("Settings"), profile: mockPageHtml("Profile") },
          meta: { durationMs: 13000, agentSteps: [], tokenUsage: { input: 12450, output: 8320 } },
          data: { pageSpecs: mockPages },
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
