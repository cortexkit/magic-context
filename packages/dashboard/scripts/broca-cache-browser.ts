// Fixture-only Cache captures: no native backend, OpenCode/Pi process or user store.
// Run from a shell that can start Chrome:
// bun packages/dashboard/scripts/broca-cache-browser.ts <output-dir> <before|after>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "");
const phase = process.argv[3];
if (!process.argv[2] || !["before", "after"].includes(phase)) throw new Error("Output directory and before/after phase required");
mkdirSync(output, { recursive: true });
const dashboard = resolve(import.meta.dir, "..");
const port = 1432;
const now = Date.UTC(2026, 8, 25, 12);
const identity = { project_root: "/fixture/project", harness: "runner", session: "alfonso:fixture-review" };
const brocaId = JSON.stringify(identity);
const usage = { input_tokens: 2200, cached_input_tokens: 17800, cache_write_tokens: 0, output_tokens: 900 };
const common = { event_count: 0, total_cache_read: 0, total_cache_write: 0, total_input: 0, hit_ratio: 0, bust_count: 0, managed: true, is_subagent: false, activity_note: null };
const sessions = [
  { ...common, harness: "broca", session_id: brocaId, title: identity.session, last_activity_ms: now, last_timestamp: new Date(now).toISOString(), broca: { session: identity, run_count: 3, warm_count: 1, first_activity_ms: now - 300000, last_activity_ms: now, usage, warm_usage: usage, models: ["anthropic/claude-sonnet-4-5"], terminal_reasons: ["completed"] } },
  { ...common, harness: "opencode", session_id: "ses_fixture", title: "Review the fixture implementation", last_activity_ms: now - 1000, last_timestamp: new Date(now - 1000).toISOString() },
];
const events = (harness: string, sessionId: string) => Array.from({ length: 4 }, (_, i) => ({
  harness, session_id: sessionId, message_id: `${harness}-step-${i}`, timestamp: now - (4 - i) * 10000,
  input_tokens: 2000, cache_read: i === 0 ? 0 : 18000 + i * 2000, cache_write: 1000,
  cache_reported: true, total_tokens: 24000 + i * 2000, hit_ratio: i === 0 ? 0 : 0.96,
  severity: i === 0 ? "info" : "stable", cause: null, agent: "build", finish: "stop",
  turn_id: `turn-${i}`, is_turn_start: true, context_limit: 200000, context_limit_estimated: false,
  is_drop: false, context_reduced_by_mc: false, cold_start: i === 0,
  aggregate: false, drop_request_size: null, cache_write_reported: true,
  provider: "anthropic", model: "claude-sonnet-4-5",
}));
const preload = (theme: string) => `(() => {
  localStorage.setItem('magic-context-dashboard.theme', ${JSON.stringify(theme)});
  window.__brocaEventCalls = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:updater|check' || cmd.startsWith('plugin:')) return null;
      if (cmd === 'get_db_health') return { exists: true, path: '/fixture/context.db', size_bytes: 0, wal_size_bytes: 0, table_counts: [] };
      if (cmd === 'get_model_catalogs') return { opencode: [], pi: [], omp: [], opencodeVariants: {} };
      if (cmd === 'get_opencode_install_state') return 'cli';
      if (cmd === 'get_session_cache_stats_from_db') return ${JSON.stringify(sessions)}.filter(s => !args.harnessFilter || s.harness === args.harnessFilter);
      if (cmd.startsWith('get_session_cache_events')) {
        if (args.harness === 'broca') window.__brocaEventCalls++;
        return args.harness === 'broca' ? ${JSON.stringify(events("broca", brocaId))} : ${JSON.stringify(events("opencode", "ses_fixture"))};
      }
      return [];
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})()`;

const vite = Bun.spawn(["timeout", "240s", join(dashboard, "node_modules/.bin/vite"), "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
  cwd: dashboard,
  stdout: "pipe",
  stderr: "inherit",
});
const chrome = Bun.spawn(["timeout", "240s", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], {
  stdout: "ignore",
  stderr: "pipe",
});
let socket: WebSocket | undefined;
try {
  console.log("Waiting for fixture Vite server");
  let viteOutput = "";
  for await (const chunk of vite.stdout) {
    viteOutput += new TextDecoder().decode(chunk);
    if (viteOutput.includes(`http://127.0.0.1:${port}`)) break;
  }
  let chromeOutput = "";
  console.log("Waiting for fixture Chrome endpoint");
  let endpoint = "";
  for await (const chunk of chrome.stderr) {
    chromeOutput += new TextDecoder().decode(chunk);
    endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(chromeOutput)?.[1] ?? "";
    if (endpoint) break;
  }
  if (!endpoint) throw new Error("Chrome debugging endpoint unavailable");
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error("Chrome connection failed"));
  });
  let commandId = 0;
  const pending = new Map<number, (result: any) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (pending.has(message.id)) {
      const done = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) throw new Error(JSON.stringify(message.error));
      done(message.result);
    }
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise((resolve) => {
      const id = ++commandId;
      pending.set(id, resolve);
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const browserSession = attached.sessionId;
  await send("Page.enable", {}, browserSession);
  await send("Runtime.enable", {}, browserSession);
  const evalPage = async <T>(expression: string, name = expression.slice(0, 100)) => {
    const response = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, browserSession);
    if (response.exceptionDetails) throw new Error(`${name}: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value;
  };
  const waitFor = (selector: string) => evalPage(`new Promise((done, fail) => {
    const find = () => document.querySelector(${JSON.stringify(selector)});
    if (find()) return done(true);
    const observer = new MutationObserver(() => { if (find()) { observer.disconnect(); done(true); } });
    observer.observe(document, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); fail(new Error('selector timeout: ' + ${JSON.stringify(selector)})); }, 15000);
  })`);
  const settle = () => evalPage("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200))))");
  const checks: string[] = [];
  const check = async (name: string, expression: string) => {
    if (!(await evalPage<boolean>(expression))) throw new Error(name);
    checks.push(name);
  };
  const hover = async (index: number) => {
    const point = await evalPage<{ x: number; y: number }>(`(() => {
      const r = document.querySelectorAll('.cache-card')[${index}].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, browserSession);
    await settle();
  };
  const capture = async (name: string) => {
    const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, browserSession);
    writeFileSync(join(output, `${phase}-${name}.png`), Buffer.from(shot.data, "base64"));
  };
  const failures: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    try {
    const preloadId = await send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: preload(theme) }, browserSession);
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, browserSession);
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, browserSession);
    await waitFor('.nav-item[title="Cache"]');
    await evalPage("document.querySelector('.nav-item[title=\"Cache\"]').click()");
    await waitFor(".cache-card");
    await settle();
    await check(`${theme}: export card keeps its figure and run count`, "document.querySelector('.cache-card').innerText.includes('89.0%') && document.querySelector('.cache-card').innerText.includes('3 runs')");
    if (phase === "after") {
      await check(`${theme}: initial selection skips the newest Broca card`, "document.querySelector('.cache-card.active')?.textContent.includes('Review the fixture implementation') && document.querySelector('.cache-chart-head')?.textContent.includes('Review the fixture implementation') && !document.querySelector('.cache-card').classList.contains('active')");
      await evalPage("window.__brocaBeforeHover = (() => { const s = getComputedStyle(document.querySelector('.cache-card')); return [s.borderColor, s.boxShadow, s.outlineStyle].join('|'); })()", `${theme}: record non-hover Broca styling`);
    }
    await hover(0);
    await capture(`${theme}-cache-session-list-broca-hover`);
    if (phase === "after") {
      await check(`${theme}: Broca card has no activation or pointer`, `(() => {
        const card = document.querySelector('.cache-card');
        return card.tagName === 'DIV' && card.tabIndex === -1 && !card.hasAttribute('aria-pressed') && getComputedStyle(card).cursor === 'default';
      })()`);
      await check(`${theme}: Broca hover does not promise an action`, "(() => { const s = getComputedStyle(document.querySelector('.cache-card')); return [s.borderColor, s.boxShadow, s.outlineStyle].join('|') === window.__brocaBeforeHover; })()");
      await evalPage("document.querySelector('.cache-card').click()", `${theme}: inert Broca click`);
      await check(`${theme}: inert card cannot change selection`, "document.querySelector('.cache-card.active')?.textContent.includes('Review the fixture implementation')");
      await check(`${theme}: no Broca timeline IPC`, "window.__brocaEventCalls === 0");
    } else {
      await check(`${theme}: baseline Broca entry opens timeline and requests`, "document.querySelector('.cache-chart-head').innerText.includes('alfonso:fixture-review') && !!document.querySelector('.cache-turns')");
      await capture(`${theme}-broca-timeline-and-requests`);
    }
    await evalPage("document.querySelectorAll('.cache-card')[1].click()");
    await settle();
    await hover(1);
    await check(`${theme}: other-host card still selects its timeline`, "document.querySelector('.cache-chart-head').innerText.includes('Review the fixture implementation') && getComputedStyle(document.querySelectorAll('.cache-card')[1]).cursor === 'pointer'");
    await capture(`${theme}-cache-other-host-hover-and-timeline`);
    await evalPage("document.querySelectorAll('.section-actions .fsel-trigger')[1].click()", `${theme}: open harness dropdown`);
    await waitFor(".fsel-dropdown");
    await evalPage("[...document.querySelectorAll('.fsel-option')].find(b => b.textContent.trim() === 'Broca').click()", `${theme}: choose Broca harness`);
    await settle();
    if (phase === "after") {
      await check(`${theme}: Broca-only list has no timeline, requests or empty panel`, "!document.querySelector('.cache-chart') && !document.querySelector('.cache-turn-row') && !!!document.querySelector('.cache-turns') && !document.querySelector('.empty-state')");
      await check(`${theme}: Broca-only cards have no selected outline`, "!document.querySelector('.cache-card.active')");
      await check(`${theme}: filtering did not request Broca events`, "window.__brocaEventCalls === 0");
    }
    await capture(`${theme}-broca-only-session-list`);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadId.identifier }, browserSession);
    } catch (error) {
      failures.push(`${theme}: ${String(error)}`);
      const html = await evalPage<string>("document.documentElement.outerHTML", "capture failure HTML");
      writeFileSync(join(output, `${phase}-failure.html`), html);
      writeFileSync(join(output, `${phase}-${theme}-failure.html`), html);
      await capture(`${theme}-failure`);
      // Clear failed-pass preloads so the next theme starts independently.
      await send("Page.navigate", { url: "about:blank" }, browserSession);
    }
  }
  writeFileSync(join(output, `${phase}-checks.json`), JSON.stringify(checks, null, 2));
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`PASS: ${checks.length} browser checks; captures under ${output}`);
} finally {
  socket?.close(); chrome.kill(); vite.kill();
  await Promise.all([chrome.exited, vite.exited]);
}
