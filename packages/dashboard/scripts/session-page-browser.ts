// Fixture-only captures for OpenCode and Pi project session pages.
// No native backend, database, home-directory config, or session files are read.
// Run: bun packages/dashboard/scripts/session-page-browser.ts <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Screenshot directory required");
mkdirSync(output, { recursive: true });
const dashboard = resolve(import.meta.dir, "..");
const port = 1431;
const projectIdentity = "git:fixture-session-pages";
const sessionRows = [
  {
    harness: "opencode",
    session_id: "oc-fixture-session",
    title: "Fixture OpenCode session with a shared header row",
    project_identity: projectIdentity,
    project_display: "fixture-project",
    last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
    is_subagent: false,
  },
  {
    harness: "pi",
    session_id: "pi-fixture-session",
    title: "Fixture Pi session with a long JSONL path",
    project_identity: projectIdentity,
    project_display: "fixture-project",
    last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
    is_subagent: false,
  },
];
const compartments = [
  {
    id: 1,
    session_id: "fixture-session",
    sequence: 1,
    start_message: 1,
    end_message: 18,
    start_message_id: "fixture-start",
    end_message_id: "fixture-end",
    title: "Mapped a session boundary to the fixture transcript",
    content: "Reviewed the project fixture and recorded the outcome.",
    created_at: Date.UTC(2026, 4, 1, 16, 40),
    start_time: Date.UTC(2026, 4, 1, 16, 21),
    end_time: Date.UTC(2026, 4, 1, 16, 48),
    importance: 72,
    episode_type: "research,decision",
    p1: "U: Review the project fixture.\nReviewed the project fixture and recorded the outcome.",
    p2: "Reviewed fixture.",
    p3: "Fixture review.",
    p4: "review",
    legacy: 0,
  },
  {
    id: 2,
    session_id: "fixture-session",
    sequence: 2,
    start_message: 19,
    end_message: 24,
    start_message_id: "fixture-second-start",
    end_message_id: "fixture-second-end",
    title: "Confirmed the final implementation checks",
    content: "Confirmed the implementation and checks.",
    created_at: Date.UTC(2026, 4, 1, 16, 48),
    start_time: Date.UTC(2026, 4, 1, 16, 49),
    end_time: Date.UTC(2026, 4, 1, 17, 2),
    importance: 50,
    episode_type: "verification",
    p1: "Confirmed the implementation and checks.",
    p2: "Confirmed checks.",
    p3: "Checks.",
    p4: "checks",
    legacy: 0,
  },
].map((comp) => ({ ...comp, session_id: "fixture-session" }));
const historianRows = {
  "oc-fixture-session": [
    {
      id: 101,
      session_id: "oc-fixture-session",
      harness: "opencode",
      subagent: "historian",
      task: null,
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      started_at: Date.UTC(2026, 4, 1, 15, 20),
      ended_at: Date.UTC(2026, 4, 1, 15, 21, 14, 383),
      status: "completed",
      input_tokens: 40_200,
      output_tokens: 2_200,
      cache_read_tokens: 32_100,
      cache_write_tokens: 1_800,
      error: null,
      parent_invocation_id: null,
    },
  ],
  "pi-fixture-session": [
    {
      id: 201,
      session_id: "pi-fixture-session",
      harness: "pi",
      subagent: "historian",
      task: "fallback",
      provider_id: "openai",
      model_id: "gpt-6.1-sol",
      started_at: Date.UTC(2026, 4, 1, 16, 20),
      ended_at: Date.UTC(2026, 4, 1, 16, 21, 14, 383),
      status: "completed",
      input_tokens: 40_200,
      output_tokens: 2_200,
      cache_read_tokens: 32_100,
      cache_write_tokens: 1_800,
      error: null,
      parent_invocation_id: null,
    },
    {
      id: 202,
      session_id: "pi-fixture-session",
      harness: "pi",
      subagent: "historian",
      task: null,
      provider_id: null,
      model_id: "gemini-3.8-flash",
      started_at: Date.UTC(2026, 4, 1, 15, 20),
      ended_at: Date.UTC(2026, 4, 1, 15, 22),
      status: "empty",
      input_tokens: 14_000,
      output_tokens: 900,
      cache_read_tokens: 8_000,
      cache_write_tokens: 400,
      error:
        'pi assistant stopped with reason "length"; tokens={"input":60965,"output":31996,"reasoning":30722,"cache_read":0,"cache_write":0,"max_tokens":32000,"finish_reason":"length"}',
      parent_invocation_id: null,
    },
  ],
};
const longPiPath = "/Users/fixture/.pi/agent/sessions/-Users-fixture-Work-fixture-project/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl";
const sessionDetail = (isPi: boolean) => ({
  harness: isPi ? "pi" : "opencode",
  session_id: isPi ? "pi-fixture-session" : "oc-fixture-session",
  title: isPi ? "Fixture Pi session with a long JSONL path" : "Fixture OpenCode session with a shared header row",
  project_identity: projectIdentity,
  project_display: "fixture-project",
  project_path: "/Users/fixture/Work/fixture-project",
  opencode_session_json: isPi ? null : { id: "oc-fixture-session" },
  pi_jsonl_path: isPi ? longPiPath : null,
  messages_count: 24,
  cache_events_count: 0,
  historian_runs: 0,
  compartments: compartments.map((comp) => ({
    ...comp,
    session_id: isPi ? "pi-fixture-session" : "oc-fixture-session",
    // Default Pi fixture data has unresolved boundary timestamps. Set the
    // screenshot flag to supply values from a JSONL timestamp lookup.
    ...(isPi && !process.env.SESSION_PAGE_EXPECT_PI_DATES ? { start_time: null, end_time: null } : {}),
  })),
  facts: [],
  notes: [],
  meta: null,
  token_breakdown: null,
  pi_compaction_entries: [],
});
const project = {
  identity: projectIdentity,
  display_name: "fixture-project",
  primary_path: "/Users/fixture/Work/fixture-project",
  harnesses: ["opencode", "pi"],
  session_count: sessionRows.length,
  memory_count: 0,
  workspace_name: null,
  last_activity_ms: Date.UTC(2026, 4, 1, 16, 48),
};
const projectInfo = { identity: projectIdentity, label: "fixture-project", path: project.primary_path };
const health = { exists: true, path: "/fixture/context.db", size_bytes: 0, wal_size_bytes: 0, table_counts: [] };
const responses = {
  get_db_health: health,
  get_model_catalogs: { opencode: [], pi: [], omp: [], opencodeVariants: {} },
  get_opencode_install_state: "cli",
  get_project_cards: [project],
  get_projects: [projectInfo],
  enumerate_memory_projects: [],
  enumerate_projects: [],
  list_sessions_paged: { rows: sessionRows, total: sessionRows.length, has_more: false, conditions: [] },
  get_session_messages: [],
  get_smart_notes: [],
  get_subagent_totals_by_subagent: [],
};
const preload = (theme: string, delayedPage = false) => `(() => {
  try { localStorage.setItem('magic-context-dashboard.theme', ${JSON.stringify(theme)}); } catch {}
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:updater|check') return null;
      if (cmd.startsWith('plugin:')) return null;
      if (${delayedPage} && cmd === 'list_sessions_paged') {
        const offset = args.filter.offset;
        (window.__listPageOffsets ??= []).push(offset);
        const rows = ${JSON.stringify(sessionRows)};
        if (offset === 0) return { rows, total: 4, has_more: true, conditions: [] };
        if (offset === 2) {
          await new Promise(resolve => { window.__releaseNextPage = resolve; });
        }
        return { rows: [{ ...rows[0], session_id: 'extra-' + offset }], total: 4, has_more: offset < 3, conditions: [] };
      }
      if (cmd === 'get_subagent_invocations') return ${JSON.stringify(historianRows)}[args.sessionId] || [];
      if (cmd === 'get_session_detail') return ${JSON.stringify(sessionDetail(false))}.session_id === args.sessionId
        ? ${JSON.stringify(sessionDetail(false))}
        : ${JSON.stringify(sessionDetail(true))};
      return cmd in ${JSON.stringify(responses)} ? ${JSON.stringify(responses)}[cmd] : [];
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})()`;

const vite = Bun.spawn(["timeout", "240s", join(dashboard, "node_modules/.bin/vite"), "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
  cwd: dashboard,
  stdout: "pipe",
  stderr: "inherit",
});
const chromeBinary = process.env.SESSION_PAGE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = Bun.spawn(["timeout", "240s", chromeBinary, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(output, "chrome-profile")}`, "about:blank"], {
  stdout: "ignore",
  stderr: "pipe",
});
let socket: WebSocket | undefined;
try {
  let viteOutput = "";
  for await (const chunk of vite.stdout) {
    viteOutput += new TextDecoder().decode(chunk);
    if (viteOutput.includes(`http://127.0.0.1:${port}`)) break;
  }
  let chromeOutput = "";
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
  const evalPage = async <T>(expression: string) => {
    const response = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, browserSession);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
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
  for (const theme of ["light", "dark"] as const) {
    const preloadId = await send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: preload(theme) }, browserSession);
    await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false }, browserSession);
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, browserSession);
    await waitFor(".project-card");
    await evalPage("document.querySelector('.project-card').click()");
    await waitFor(".project-detail-body .scroll-area button.card");
    for (const [kind, title] of [["opencode", "Fixture OpenCode session"], ["pi", "Fixture Pi session with a long JSONL path"]] as const) {
      await evalPage(`(() => {
        const row = [...document.querySelectorAll('.project-detail-body .scroll-area button.card')]
          .find((element) => element.textContent.includes(${JSON.stringify(title)}));
        if (!row) throw new Error('missing session row: ' + ${JSON.stringify(title)} + ' body=' + document.body.innerText.slice(0, 1000));
        row.click();
      })()`);
      await waitFor(".tab-pill");
      await waitFor(".section-header");
      await waitFor("#compartment-1");
      await settle();
      await evalPage(`(() => {
        const first = document.querySelector('#compartment-1');
        const second = document.querySelector('#compartment-2');
        const body = (card) => card.querySelector('.expandable-content');
        if (body(first)?.childElementCount || body(second)?.childElementCount) {
          throw new Error('collapsed compartment mounted body elements');
        }
        first.click();
        const lines = [...body(first).lastElementChild.children].map((line) => line.textContent);
        const expected = ${JSON.stringify(compartments[0].p1.split("\n"))};
        if (lines.length !== expected.length || lines.some((line, i) => line !== expected[i])) {
          throw new Error('open compartment did not render its separate P1 lines');
        }
        [...body(first).querySelectorAll('button')].find((button) => button.textContent === 'P2').click();
        if (body(first).lastElementChild.textContent !== ${JSON.stringify(compartments[0].p2)}) {
          throw new Error('tier change did not render the selected body');
        }
        first.click();
        if (body(first)?.childElementCount) throw new Error('closing a compartment retained its body');
        first.click();
        if (body(first).lastElementChild.textContent !== ${JSON.stringify(compartments[0].p2)}) {
          throw new Error('reopening a compartment did not restore the selected tier');
        }
        [...body(first).querySelectorAll('button')].find((button) => button.textContent === 'P1').click();
        second.click();
        if (body(first)?.childElementCount || body(second).lastElementChild.textContent !== ${JSON.stringify(compartments[1].p1)}) {
          throw new Error('switching cards did not replace the mounted body');
        }
        second.click();
      })()`);
      console.log(`${theme}/${kind}: collapsed compartment bodies are not mounted; open bodies and tier selection are preserved`);
      if (kind === "pi" && process.env.SESSION_PAGE_EXPECT_PI_DATES) {
        const visibleDate = await evalPage("[...document.querySelectorAll('.list-gap button.card')].some((card) => card.innerText.includes(' → '))");
        if (!visibleDate) throw new Error("Pi compartment date fixture was not rendered");
        const pathIsContained = await evalPage(`(() => {
          const path = [...document.querySelectorAll('.card-meta .id-text')].find((element) => element.title === ${JSON.stringify(longPiPath)});
          const card = path?.closest('.card');
          if (!path || !card) return false;
          const pathRect = path.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          return pathRect.right <= cardRect.right && cardRect.right <= innerWidth;
        })()`);
        if (!pathIsContained) throw new Error("Pi JSONL path escapes its header card at 900px");
        const headerAligned = await evalPage(`(() => {
          const header = document.querySelector('.section-header h1');
          const back = header?.querySelector('.btn.sm');
          const badge = header?.querySelector('.pill');
          const title = header?.querySelector(':scope > span > span:last-child');
          if (!back || !badge || !title) return false;
          const centers = [back, badge, title].map((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });
          return Math.max(...centers) - Math.min(...centers) < 4;
        })()`);
        if (!headerAligned) throw new Error("Session header controls do not share a centered row");
      }
      const screenshot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, browserSession);
      const sessionFilename = join(output, `${theme}-900-${kind}-session.png`);
      writeFileSync(sessionFilename, Buffer.from(screenshot.data, "base64"));
      console.log(`captured ${sessionFilename}`);
      await evalPage("[...document.querySelectorAll('.tab-pill')].find((button) => button.textContent.includes('Historian'))?.click()");
      await waitFor(".kv-table");
      await settle();
      if (process.env.SESSION_PAGE_EXPECT_PI_DATES) {
        const historianLooksFormatted = await evalPage(`(() => {
          const table = document.querySelector('.historian-table');
          if (!table) return false;
          const text = table.innerText;
          return text.includes('Provider / Model') && text.includes('74.4 s') &&
            text.includes('40.2k in · 2.2k out');
        })()`);
        if (!historianLooksFormatted) throw new Error("Historian provider, fallback, duration, or token formatting is missing");
        const historianFitsViewport = await evalPage(`(() => {
          const table = document.querySelector('.historian-table');
          if (!table) return false;
          const cells = table.querySelector('tbody tr')?.children;
          if (!cells || cells.length !== 7) return false;
          return table.scrollWidth <= table.clientWidth + 1 &&
            table.getBoundingClientRect().right <= innerWidth &&
            cells[3].textContent.trim() === 'completed' &&
            cells[4].textContent.trim() === '74.4 s' &&
            cells[5].getAttribute('title')?.includes('40,200') &&
            cells[5].getAttribute('title')?.includes('2,200');
        })()`);
        if (!historianFitsViewport) throw new Error("Historian columns overflow or omit full token counts at 900px");
        if (kind === "pi") {
          const piHistorianLabels = await evalPage("document.querySelector('.historian-table')?.innerText.includes('fallback') && document.querySelector('.historian-table')?.innerText.includes('— / gemini-3.8-flash')");
          if (!piHistorianLabels) throw new Error("Pi fixture provider placeholder or fallback marker is missing");
        }
      }
      const historianScreenshot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, browserSession);
      const historianFilename = join(output, `${theme}-900-${kind}-historian.png`);
      writeFileSync(historianFilename, Buffer.from(historianScreenshot.data, "base64"));
      console.log(`captured ${historianFilename}`);
      if (kind === "pi") {
        // A long error must stay a single icon in the row and open as a card
        // on hover, inside the viewport, instead of widening the table.
        const iconCenter = await evalPage(`(() => {
          const table = document.querySelector('.historian-table');
          const icon = document.querySelector('.historian-error-icon');
          if (!table || !icon) return null;
          if (table.scrollWidth > table.clientWidth + 1) return null;
          const r = icon.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!iconCenter) throw new Error("Historian error icon is missing or the table overflows");
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: iconCenter.x, y: iconCenter.y }, browserSession);
        await settle();
        const cardFits = await evalPage(`(() => {
          const card = document.querySelector('.historian-error-card');
          if (!card || getComputedStyle(card).display === 'none') return false;
          const r = card.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && card.textContent.includes('finish_reason');
        })()`);
        if (!cardFits) throw new Error("Historian error card did not open inside the viewport on hover");
        const hoverShot = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, browserSession);
        const hoverFilename = join(output, `${theme}-900-pi-historian-error-hover.png`);
        writeFileSync(hoverFilename, Buffer.from(hoverShot.data, "base64"));
        console.log(`captured ${hoverFilename}`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 }, browserSession);
      }
      if (kind === "opencode") {
        await evalPage("document.querySelector('.section-header .btn.sm').click()");
        await waitFor(".project-detail-body .scroll-area button.card");
      }
    }
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadId.identifier }, browserSession);
  }
  const pagingPreload = await send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
    source: preload("light", true),
  }, browserSession);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, browserSession);
  await waitFor(".project-card");
  await evalPage("document.querySelector('.project-card').click()");
  await waitFor(".project-detail-body .scroll-area button.card");
  await evalPage(`new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!window.__releaseNextPage) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }, 20);
    const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('next page was not requested')); }, 5000);
  })`);
  await evalPage(`(() => {
    document.querySelector('.project-detail-body .scroll-area button.card').click();
    if (!document.querySelector('.tab-pill')) throw new Error('session did not open');
    document.querySelector('.nav-item[title="Workspaces"]').click();
    if (document.querySelector('.project-detail-body')) throw new Error('session view did not unmount');
    window.__pagingLongTasks = [];
    new PerformanceObserver(list => window.__pagingLongTasks.push(...list.getEntries())).observe({ type: 'longtask' });
  })()`);
  await settle();
  await send("Performance.enable", {}, browserSession);
  const before = await send<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics", {}, browserSession);
  await evalPage("window.__releaseNextPage()");
  const idleMs = Number(process.env.SESSION_PAGE_PAGING_IDLE_MS ?? 250);
  await Bun.sleep(idleMs);
  const after = await send<typeof before>("Performance.getMetrics", {}, browserSession);
  const delta = (name: string) => {
    const value = (sample: typeof before) => sample.metrics.find(metric => metric.name === name)!.value;
    return value(after) - value(before);
  };
  const result = await evalPage<{ offsets: number[]; longTasks: number; longTaskMs: number }>(`({
    offsets: window.__listPageOffsets, longTasks: window.__pagingLongTasks.length,
    longTaskMs: window.__pagingLongTasks.reduce((sum, entry) => sum + entry.duration, 0),
  })`);
  console.log(`session pagination after navigation (${idleMs} ms): ${JSON.stringify({ ...result, layouts: delta("LayoutCount"), layoutMs: delta("LayoutDuration") * 1000 })}`);
  if (result.offsets.join(",") !== "0,2") throw new Error("session pagination continued after unmount");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: pagingPreload.identifier }, browserSession);
} finally {
  socket?.close();
  chrome.kill();
  vite.kill();
  await Promise.all([chrome.exited, vite.exited]);
}
