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
  .argument("<prompt>", "Description of the page to generate")
  .option("-o, --output <file>", "Output file path", "output.html")
  .option("-t, --type <pageType>", "Page type hint (e.g. landing, dashboard, blog)")
  .option("--palette <colors...>", "Color palette (space-separated hex codes)")
  .option("--planner <type>", "Pipeline planner: static or llm", "static")
  .option("--quiet", "Suppress progress output")
  .option("-s, --serve [port]", "Serve the output on localhost after generation")
  .option("-l, --live [port]", "Live preview in browser during generation")
  .option("--no-validate", "Skip the validation step")
  .action(async (prompt: string, opts) => {
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

    // After generation completes, serve the final HTML on reload
    if (finalHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(finalHtml);
      return;
    }

    // During generation, serve the live preview page
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
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #fff; height: 100vh; display: flex; flex-direction: column; }
    .page-tabs { display: none; background: #1a1a1a; padding: 0 12px; gap: 0; overflow-x: auto; white-space: nowrap; }
    .page-tabs.visible { display: flex; }
    .page-tab { padding: 8px 16px; font-size: 13px; font-family: system-ui, sans-serif; background: none; color: #a0a0a0; border: none; border-bottom: 2px solid transparent; cursor: pointer; }
    .page-tab:hover { color: #e0e0e0; }
    .page-tab.active { color: #fff; border-bottom-color: #5046e5; }
    .status { position: fixed; bottom: 12px; right: 12px; background: #1a1a1a; color: #93c5fd; font: 12px/1.4 ui-monospace, monospace; padding: 6px 12px; border-radius: 6px; z-index: 9999; opacity: 0.9; }
    .status.done { color: #34d399; }
    iframe { flex: 1; border: none; width: 100%; }
  </style>
</head>
<body>
  <div class="page-tabs" id="page-tabs"></div>
  <iframe id="preview"></iframe>
  <div class="status" id="status">Connecting...</div>
  <script>
    let pestoCss = '';
    let rendererBuffer = '';
    let iframeDocOpened = false;
    let lastWrittenLength = 0;
    let pendingChunks = '';
    let rafId = 0;
    let streamingAgent = '';
    let resultPages = null;

    const status = document.getElementById('status');
    const iframe = document.getElementById('preview');

    function flushChunks() {
      rafId = 0;
      if (!pendingChunks) return;
      try {
        const doc = iframe.contentDocument;
        if (doc) doc.write(pendingChunks);
      } catch (e) {}
      pendingChunks = '';
    }

    function scheduleFlush() {
      if (!rafId) rafId = requestAnimationFrame(flushChunks);
    }

    function stripOutputTags(buf) {
      return buf
        .replace(/^[\\s\\S]*?<html_output>\\s*/i, '')
        .replace(/<\\/html_output>[\\s\\S]*$/i, '');
    }

    function switchPage(pageId) {
      if (!resultPages || !resultPages[pageId]) return;
      iframe.srcdoc = resultPages[pageId];
      document.querySelectorAll('.page-tab').forEach(t =>
        t.classList.toggle('active', t.textContent === pageId)
      );
    }

    // Intercept link clicks inside the iframe to enable seamless page navigation
    function interceptIframeLinks() {
      if (!resultPages) return;
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href');
          const match = href && href.match(/^([\\w-]+)\\.html$/);
          if (match && resultPages[match[1]]) {
            a.addEventListener('click', (e) => {
              e.preventDefault();
              switchPage(match[1]);
            });
          }
        });
      } catch (e) { /* cross-origin safety */ }
    }

    iframe.addEventListener('load', interceptIframeLinks);

    const es = new EventSource('/events');
    es.onopen = () => { status.textContent = 'Connected — waiting for generation...'; };

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'pipeline_start':
          status.textContent = 'Pipeline: ' + msg.pipeline.steps.length + ' steps';
          break;
        case 'agent_start':
          status.textContent = msg.agentName + ' (phase ' + msg.phase + ')...';
          break;
        case 'agent_complete':
          status.textContent = msg.agentName + ' done (' + msg.result.durationMs + 'ms)';
          break;
        case 'design_tokens':
          pestoCss = msg.css;
          break;
        case 'agent_chunk':
          if (msg.agentName === 'renderer' || msg.agentName.startsWith('renderer_')) {
            if (!streamingAgent) streamingAgent = msg.agentName;
            if (msg.agentName !== streamingAgent) break;
            rendererBuffer += msg.chunk;
            const cleaned = stripOutputTags(rendererBuffer);

            if (!iframeDocOpened) {
              try {
                const doc = iframe.contentDocument;
                doc.open();
                if (pestoCss) doc.write('<style id="pesto-tokens">' + pestoCss + '</style>');
                iframeDocOpened = true;
                lastWrittenLength = 0;
              } catch (e) { break; }
            }

            const newContent = cleaned.substring(lastWrittenLength);
            if (newContent) {
              pendingChunks += newContent;
              lastWrittenLength = cleaned.length;
              scheduleFlush();
            }
          }
          break;
        case 'pipeline_complete':
          status.textContent = 'Complete in ' + (msg.result.meta.durationMs / 1000).toFixed(1) + 's';
          status.className = 'status done';
          break;
        case 'result':
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          flushChunks();
          try { if (iframeDocOpened) iframe.contentDocument.close(); } catch (e) {}

          iframe.srcdoc = msg.result.html;

          if (msg.result.pages && Object.keys(msg.result.pages).length > 1) {
            resultPages = msg.result.pages;
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
          }
          break;
      }
    };
  </script>
</body>
</html>`;

program.parse();
