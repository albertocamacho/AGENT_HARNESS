import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { createHarness } from "../core/factory.js";

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const harness = createHarness({
  planner: (process.env.PLANNER as "static" | "llm") ?? "static",
});

// ── Multi-page state for serving in-iframe navigation ──────────
let latestPages: Record<string, string> | null = null;

// ── Serve individual pages for in-iframe link navigation ───────
app.get("/:pageId.html", (req, res) => {
  if (latestPages) {
    const pageHtml = latestPages[req.params.pageId];
    if (pageHtml) {
      res.type("html").send(pageHtml);
      return;
    }
  }
  res.type("html").send(WEB_UI_HTML);
});

// ── Serve the web UI ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.type("html").send(WEB_UI_HTML);
});

// ── WebSocket handler ───────────────────────────────────────────
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg: { type: string; prompt?: string; constraints?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "generate" && msg.prompt) {
      const send = (data: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        }
      };

      try {
        const result = await harness.run({
          id: nanoid(),
          prompt: msg.prompt,
          constraints: msg.constraints as any,
          onProgress: (event) => send(event),
        });

        if (result.pages) latestPages = result.pages;
        send({ type: "result", result });
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
});

const port = parseInt(process.env.PORT ?? "3100", 10);
server.listen(port, () => {
  console.log(`Agent harness web UI: http://localhost:${port}`);
  console.log(`WebSocket endpoint:   ws://localhost:${port}/ws`);
});

// ── Inline HTML for the web UI ──────────────────────────────────
const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Harness</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; height: 100vh; }
    .sidebar { width: 400px; padding: 24px; display: flex; flex-direction: column; gap: 16px; border-right: 1px solid #2a2a2a; overflow-y: auto; }
    .preview { flex: 1; background: #fff; }
    .preview iframe { width: 100%; height: 100%; border: none; }
    h1 { font-size: 18px; font-weight: 500; }
    textarea { width: 100%; height: 120px; background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; border-radius: 8px; padding: 12px; font: inherit; resize: vertical; }
    button { background: #5046e5; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font: inherit; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .log { flex: 1; min-height: 120px; overflow-y: auto; font-size: 13px; font-family: ui-monospace, monospace; background: #1a1a1a; border-radius: 8px; padding: 12px; }
    .log-entry { padding: 4px 0; border-bottom: 1px solid #222; }
    .log-entry.error { color: #f87171; }
    .log-entry.done { color: #34d399; }
    .log-entry.start { color: #93c5fd; }
    .spec-panel { display: none; max-height: 260px; overflow-y: auto; font-size: 12px; font-family: ui-monospace, monospace; background: #141414; border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px; white-space: pre-wrap; word-wrap: break-word; color: #a0a0a0; }
    .spec-panel h2 { font-size: 13px; font-weight: 600; color: #93c5fd; margin-bottom: 8px; white-space: normal; }
    .page-tabs { display: none; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; padding: 0 12px; gap: 0; overflow-x: auto; white-space: nowrap; }
    .page-tabs.visible { display: flex; }
    .page-tab { padding: 8px 16px; font-size: 13px; font-family: system-ui, sans-serif; background: none; color: #a0a0a0; border: none; border-bottom: 2px solid transparent; cursor: pointer; }
    .page-tab:hover { color: #e0e0e0; }
    .page-tab.active { color: #fff; border-bottom-color: #5046e5; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h1>Agent harness</h1>
    <textarea id="prompt" placeholder="Describe the page you want to generate..."></textarea>
    <button id="go" onclick="generate()">Generate</button>
    <div class="log" id="log"></div>
    <div class="spec-panel" id="spec-panel">
      <h2>Architect Spec</h2>
      <pre id="spec-content" style="margin:0;font:inherit;white-space:pre-wrap;"></pre>
    </div>
  </div>
  <div class="preview" style="display:flex;flex-direction:column;">
    <div class="page-tabs" id="page-tabs"></div>
    <iframe id="preview" style="flex:1;"></iframe>
  </div>
  <script>
    let ws;
    // Progressive rendering state
    let pestoCss = '';
    let rendererBuffer = '';
    let iframeDocOpened = false;
    let lastWrittenLength = 0;
    let pendingChunks = '';
    let rafId = 0;
    // Track which renderer to stream (first one, or the single 'renderer')
    let streamingAgent = '';
    // Multi-page state
    let resultPages = null;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      };
      ws.onclose = () => setTimeout(connect, 1000);
    }
    connect();

    function log(text, cls = '') {
      const el = document.createElement('div');
      el.className = 'log-entry ' + cls;
      el.textContent = text;
      document.getElementById('log').appendChild(el);
      el.scrollIntoView();
    }

    function generate() {
      const prompt = document.getElementById('prompt').value.trim();
      if (!prompt) return;

      document.getElementById('log').innerHTML = '';
      document.getElementById('go').disabled = true;
      document.getElementById('spec-panel').style.display = 'none';
      document.getElementById('spec-content').textContent = '';

      // Reset progressive rendering state
      rendererBuffer = '';
      iframeDocOpened = false;
      lastWrittenLength = 0;
      pendingChunks = '';
      streamingAgent = '';
      resultPages = null;
      document.getElementById('page-tabs').innerHTML = '';
      document.getElementById('page-tabs').classList.remove('visible');
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

      ws.send(JSON.stringify({ type: 'generate', prompt }));
      log('Starting generation...', 'start');
    }

    function flushChunks() {
      rafId = 0;
      if (!pendingChunks) return;
      try {
        const iframe = document.getElementById('preview');
        const doc = iframe.contentDocument;
        if (doc) doc.write(pendingChunks);
      } catch (e) { /* iframe may be transitioning */ }
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
      const iframe = document.getElementById('preview');
      iframe.srcdoc = resultPages[pageId];
      const tabs = document.querySelectorAll('.page-tab');
      tabs.forEach(t => t.classList.toggle('active', t.textContent === pageId));
    }

    // Intercept link clicks inside the iframe to enable seamless page navigation
    function interceptIframeLinks() {
      if (!resultPages) return;
      const iframe = document.getElementById('preview');
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

    // Re-intercept links each time the iframe loads new content
    document.getElementById('preview').addEventListener('load', interceptIframeLinks);

    function handleMessage(msg) {
      switch (msg.type) {
        case 'pipeline_start':
          log('Pipeline: ' + msg.pipeline.steps.length + ' steps', 'start');
          break;
        case 'agent_start':
          log('Running: ' + msg.agentName + ' (phase ' + msg.phase + ')', 'start');
          break;
        case 'agent_complete':
          log('Done: ' + msg.agentName + ' (' + msg.result.durationMs + 'ms)', 'done');
          break;
        case 'design_tokens':
          pestoCss = msg.css;
          break;
        case 'agent_artifact':
          if (msg.agentName === 'architect') {
            document.getElementById('spec-panel').style.display = 'block';
            document.getElementById('spec-content').textContent = msg.artifact;
          }
          break;
        case 'agent_chunk':
          if (msg.agentName === 'renderer' || msg.agentName.startsWith('renderer_')) {
            // In multi-page mode, only stream the first renderer we see (landing page)
            // to avoid interleaving chunks from parallel renderers
            if (!streamingAgent) streamingAgent = msg.agentName;
            if (msg.agentName !== streamingAgent) break;
            rendererBuffer += msg.chunk;
            const cleaned = stripOutputTags(rendererBuffer);

            // Open the iframe document on the first chunk
            if (!iframeDocOpened) {
              try {
                const iframe = document.getElementById('preview');
                const doc = iframe.contentDocument;
                doc.open();
                // Inject Pesto design tokens so partial HTML renders styled
                if (pestoCss) {
                  doc.write('<style id="pesto-tokens">' + pestoCss + '</style>');
                }
                iframeDocOpened = true;
                lastWrittenLength = 0;
              } catch (e) { break; }
            }

            // Write only the new portion since last flush
            const newContent = cleaned.substring(lastWrittenLength);
            if (newContent) {
              pendingChunks += newContent;
              lastWrittenLength = cleaned.length;
              scheduleFlush();
            }
          }
          break;
        case 'pipeline_complete':
          log('Complete! ' + msg.result.meta.durationMs + 'ms total', 'done');
          document.getElementById('go').disabled = false;
          break;
        case 'result': {
          // Flush any remaining progressive chunks
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          flushChunks();
          try {
            const iframe = document.getElementById('preview');
            if (iframeDocOpened) iframe.contentDocument.close();
          } catch (e) { /* ok */ }
          // Replace with canonical post-processed HTML
          const iframe = document.getElementById('preview');
          iframe.srcdoc = msg.result.html;

          // Multi-page: build page tabs
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
            log(Object.keys(resultPages).length + ' pages rendered', 'done');
          } else {
            log('Page rendered in preview', 'done');
          }
          document.getElementById('go').disabled = false;
          break;
        }
        case 'error':
          log('Error: ' + (msg.error || 'unknown'), 'error');
          document.getElementById('go').disabled = false;
          break;
      }
    }
  </script>
</body>
</html>`;
