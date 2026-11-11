// Fixture-only visual and interaction gate. No native backend or operator config is contacted.
// Run: timeout 300s bun packages/dashboard/scripts/config-browser.ts "$TMPDIR/magic-context/dashboard-responsive"
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJsonc } from "../src/lib/jsonc";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Screenshot directory required");
mkdirSync(root, { recursive: true });
const dashboard = resolve(import.meta.dir, "..");
const viewports = process.env.CONFIG_BROWSER_VIEWPORTS
  ? process.env.CONFIG_BROWSER_VIEWPORTS.split(",").map((size) => size.split("x").map(Number))
  : [[900, 800], [1100, 800], [1400, 900], [1900, 1100]];
if (viewports.some((size) => size.length !== 2 || size.some((value) => !Number.isInteger(value) || value <= 0))) throw new Error("Invalid browser viewport");
const fixture = `{
  // Operator's comment must survive form saves.
  "enabled": true,
  "embedding": {
    "provider": "openai-compatible",
    "endpoint": "https://openrouter.ai/api/v1",
    "model": "qwen/qwen3-embedding-8b",
  },
  "mural": { "model": "google/antigravity-gemini-3.8-flash" },
  "historian": { "opencode": {
    "model": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" },
    "fallback_models": [ { "model": "deepseek/deepseek-flash", "variant": "high" }, "openrouter/qwen/qwen3-235b-a22b" ],
  } },
  "dreamer": { "opencode": {
    "model": "google/antigravity-gemini-3.8-flash",
    "fallback_models": [ { "model": "deepseek/deepseek-flash", "variant": "high" }, "openai/gpt-5" ],
  } },
  "prompt_surface": { "models": { "anthropic/*": "full", "openrouter/qwen/qwen3-235b-a22b": "light" } },
  "pi": { "subagent_extensions": ["extensions/project-specific-tooling.ts", "npm:@cortexkit/example-extension"] },
  "dashboard": { "opencode_db_paths": ["/Volumes/Archive/opencode"] },
  "future_operator_setting": { "keep_spacing" :  42, },
}
`.replaceAll("\n", "\r\n");
const catalogs = {
  opencode: ["anthropic/claude-sonnet-4-5", "google/antigravity-gemini-3.8-flash", "deepseek/deepseek-flash", "openai/gpt-5", "openrouter/qwen/qwen3-235b-a22b"],
  pi: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
  omp: ["opencode-zen/gpt-5"],
  opencodeVariants: { "anthropic/claude-sonnet-4-5": ["low", "high", "adaptive"], "google/antigravity-gemini-3.8-flash": [] },
};
const preload = `(() => {
  let config = ${JSON.stringify(fixture)};
  window.__fixtureConfig = ${JSON.stringify(parseJsonc(fixture))};
  window.__fixtureCalls = []; window.__fixtureSaved = null;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      window.__fixtureCalls.push(cmd);
      if (cmd === 'get_config') return { path: '/fixture/operator/configuration-directory/cortexkit/magic-context.jsonc', exists: true, content: config, error: null };
      if (cmd === 'save_config') { config = args.content; window.__fixtureSaved = config; return null; }
      if (cmd === 'get_model_catalogs') return ${JSON.stringify(catalogs)};
      if (cmd === 'get_opencode_install_state') return 'cli';
      if (cmd === 'get_opencode_stores') return [
        { path: '/fixture/home/.local/share/opencode/opencode.db', origin: 'default', found: true, read: true, note: null, configured_value: null },
        { path: '/fixture/home/.local/share/cortexkit/thalamus-harness/opencode2-server/data/opencode/opencode.db', origin: 'runner', found: true, read: true, note: null, configured_value: null },
        { path: '/Volumes/Archive/opencode/opencode.db', origin: 'configured', found: false, read: false, note: 'Not found.', configured_value: '/Volumes/Archive/opencode' },
      ];
      if (cmd === 'get_db_health') return { found: true, path: '/fixture/context.db', size_bytes: 1, tables: [], error: null };
      if (cmd === 'plugin:updater|check') return null;
      return [];
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})()`;

const vite = Bun.spawn(["timeout", "270s", join(dashboard, "node_modules/.bin/vite"), "--port", "1427", "--host", "127.0.0.1"], { cwd: dashboard, stdout: "pipe", stderr: "inherit" });
const chrome = Bun.spawn(["timeout", "270s", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${join(root, "chrome-profile")}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
let socket: WebSocket | undefined;
const screenshots: string[] = [];
const checks: string[] = [];
const layoutMeasurements: unknown[] = [];
try {
  let ready = "";
  for await (const chunk of vite.stdout) {
    ready += new TextDecoder().decode(chunk);
    if (ready.includes("http://127.0.0.1:1427")) break;
  }
  let endpoint = "";
  let output = "";
  for await (const chunk of chrome.stderr) {
    output += new TextDecoder().decode(chunk);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
    if (match) { endpoint = match[1]; break; }
  }
  if (!endpoint) throw new Error("Chromium debugging endpoint unavailable");
  socket = new WebSocket(endpoint);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error("Chromium connection failed")); });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => new Promise((done, fail) => {
    const command = ++id;
    const timer = setTimeout(() => { pending.delete(command); fail(new Error(`${method} timed out`)); }, 30000);
    pending.set(command, { resolve: (value) => { clearTimeout(timer); done(value as T); }, reject: (error) => { clearTimeout(timer); fail(error); } });
    socket!.send(JSON.stringify({ id: command, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const version = await send<{ product: string }>("Browser.getVersion");
  console.log(version.product);
  const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  const evaluate = async <T>(expression: string) => {
    const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const assert = async (name: string, expression: string) => {
    if (!await evaluate<boolean>(expression)) {
      writeFileSync(join(root, "failure.json"), JSON.stringify({ name, checks, layoutMeasurements }, null, 2));
      throw new Error(`Browser check failed: ${name}`);
    }
    checks.push(name);
  };
  const frame = () => evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
  const waitFor = (selector: string) => evaluate(`new Promise((done, fail) => { const observer=new MutationObserver(check); function check(){if(document.querySelector(${JSON.stringify(selector)})){observer.disconnect();done(true)}} observer.observe(document,{childList:true,subtree:true});check();setTimeout(()=>{observer.disconnect();fail(new Error('selector not reached: '+${JSON.stringify(selector)}))},15000) })`);
  const click = async (selector: string) => { await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error('missing '+${JSON.stringify(selector)}); element.scrollIntoView({block:'center'});element.click(); })()`); await frame(); };
  const input = async (selector: string, value: string) => { await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));})()`); await frame(); };
  const capture = async (name: string) => {
    await frame();
    const result = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
    const path = join(root, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    screenshots.push(path);
  };
  const section = async (name: string) => {
    await evaluate(`[...document.querySelectorAll('.config-section-index button')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click();document.querySelector('.scroll-area').scrollTop=0`);
    await frame();
  };
  await send("Page.enable", {}, sid);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: preload }, sid);
  for (const [width, height] of viewports) {
    const size = `${width}x${height}`;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    await send("Page.navigate", { url: "http://127.0.0.1:1427" }, sid);
    await waitFor('.nav-item[title="Config"]');
    await click('.nav-item[title="Config"]');
    await waitFor('.config-section-panel');
    await assert(`${size} clean save is disabled`, "document.querySelector('.config-save').disabled");
    await assert(`${size} config path stays on one line with full hover text`, "(()=>{const e=document.querySelector('.config-file-meta code'),s=getComputedStyle(e);return e.title===e.textContent && s.whiteSpace==='nowrap' && s.textOverflow==='ellipsis'})()");
    for (const name of ["General", "Context window", "History", "Memory & search", "Background models", "Dreamer schedule", "Prompt surface", "Session stores", "Advanced"]) {
      await section(name);
      const slug = name.toLowerCase().replaceAll(/[^a-z]+/g, "-").replace(/-$/, "");
      await assert(`${size} ${name} single-column rows`, `[...document.querySelectorAll('.config-card-content')].filter(e=>e.getClientRects().length).every(e=>getComputedStyle(e).flexDirection==='column')`);
      await assert(`${size} ${name} last row has no bottom border`, `getComputedStyle([...document.querySelectorAll('.config-section-panel .config-field')].filter(e=>e.getClientRects().length).at(-1)).borderBottomWidth==='0px'`);
      // Width-bearing data controls must not collapse. Icon buttons and checkbox tracks
      // intentionally remain compact, so they are not data-entry controls in this check.
      const controls = await evaluate<{ label: string; width: number; height: number }[]>(`[...document.querySelectorAll('.config-section-panel input:not([type="checkbox"]), .config-section-panel select, .config-section-panel textarea, .config-section-panel .model-select-trigger')].filter(e=>e.getClientRects().length).map(e=>({label:e.getAttribute('aria-label')||e.title||e.placeholder||e.textContent.trim(),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
      layoutMeasurements.push({ size, section: name, controls });
      await assert(`${size} ${name} data controls are at least 120px wide`, `${controls.length}>0 && ${JSON.stringify(controls)}.every(control=>control.width>=120 && control.height>=20)`);
      await assert(`${size} ${name} stays within the page width`, "(()=>{const e=document.querySelector('.scroll-area');return e.scrollWidth<=e.clientWidth})()");
      await assert(`${size} ${name} model and qualifier values do not wrap`, "[...document.querySelectorAll('.config-section-panel .model-select-trigger')].filter(e=>e.getClientRects().length).every(button=>{const value=button.querySelector('.model-select-value'),style=getComputedStyle(value);return button.title===value.textContent.trim() && style.whiteSpace==='nowrap' && style.textOverflow==='ellipsis' && button.getBoundingClientRect().height<=40})");
      if (name === "Background models") {
        for (const agent of ["historian", "dreamer"]) {
          const entries = await evaluate<string[]>(`window.__fixtureConfig.${agent}.opencode.fallback_models.map(entry=>typeof entry==='string'?entry:entry.model)`);
          await assert(`${size} ${agent} fallback rows match configured entries`, `document.querySelectorAll('[data-agent="${agent}"] .model-chain-item').length===${entries.length}`);
          for (const model of entries) {
            const measurement = await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-agent="${agent}"] .model-chain-item .model-select-trigger')].find(e=>e.querySelector('.model-select-value').textContent.trim()===${JSON.stringify(model)});if(!button)return{model:${JSON.stringify(model)},rendered:false};button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{model:${JSON.stringify(model)},rendered:true,width:r.width,height:r.height,uncovered:button.contains(hit),hit:hit?.closest('button')?.textContent.trim()}})()`);
            layoutMeasurements.push({ size, agent, fallback: measurement });
            console.log(`Fallback layout ${size} ${agent}: ${JSON.stringify(measurement)}`);
            const snapshot = `(${JSON.stringify(measurement)})`;
            await assert(`${size} ${agent} configured fallback ${model} is visible`, `${snapshot}.rendered && ${snapshot}.width>=120 && ${snapshot}.height>=20 && ${snapshot}.uncovered`);
          }
        }
        await section(name);
      }
      await capture(`${size}-${slug}`);
      const scroll = await evaluate<{ total: number; viewport: number }>("(()=>{const e=document.querySelector('.scroll-area');return{total:e.scrollHeight,viewport:e.clientHeight}})()");
      for (let y = scroll.viewport - 120, page = 2; y < scroll.total - 120; y += scroll.viewport - 120, page++) {
        await evaluate(`document.querySelector('.scroll-area').scrollTop=${y}`);
        await capture(`${size}-${slug}-${page}`);
      }
    }
    await section("Session stores");
    await assert(`${size} session stores list every store with its source`, "[...document.querySelectorAll('.config-store-table tbody tr')].map(r=>r.children[1].textContent).join('|')==='Default|CortexKit runner|Configured'");
    await assert(`${size} session store paths are selectable`, "[...document.querySelectorAll('.config-store-path')].every(e=>getComputedStyle(e).userSelect==='text')");
    await assert(`${size} only configured stores can be removed`, "document.querySelectorAll('.config-store-table [aria-label^=\"Remove session store\"]').length===1");
    await input('[aria-label="New session store path"]', "relative/opencode.db");
    await click('[aria-label="Add session store"]');
    await assert(`${size} a relative store path is refused`, "document.querySelector('.config-store-error').textContent.includes('absolute path') && document.querySelector('.config-save').disabled");
    await input('[aria-label="New session store path"]', "/srv/runner-copy/opencode.db");
    await click('[aria-label="Add session store"]');
    await assert(`${size} an added store shows as not saved and marks the form dirty`, "document.querySelectorAll('.config-store-table tbody tr').length===4 && document.querySelector('.config-store-table tbody tr:last-child').textContent.includes('Not saved yet') && !document.querySelector('.config-save').disabled");
    for (const theme of ["dark", "light"]) {
      await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
      await capture(`${size}-session-stores-${theme}`);
    }
    await evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
    await click('[aria-label="Remove session store /srv/runner-copy/opencode.db"]');
    await assert(`${size} removing the added store leaves nothing to save`, "document.querySelectorAll('.config-store-table tbody tr').length===3 && document.querySelector('.config-save').disabled");
    await section("Context window");
    await click('[aria-label="Help: Cache TTL"]');
    await assert(`${size} help portal and keyboard focus`, "!!document.querySelector('.config-help-popover') && !document.querySelector('.config-help-popover').closest('.config-editor') && document.activeElement.tagName==='A'");
    await capture(`${size}-help-popover`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sid);
    await assert(`${size} help closes on Escape and returns focus`, "!document.querySelector('.config-help-popover') && document.activeElement.getAttribute('aria-label')==='Help: Cache TTL'");
    await click('[aria-label="Help: Cache TTL"]');
    await evaluate("document.querySelector('.config-section-panel h2').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
    await assert(`${size} help closes on outside click`, "!document.querySelector('.config-help-popover')");
    await section("General");
    // The trigger's accessible name carries its value ("Output Language: …"), so match the prefix.
    await click('button[aria-label^="Output Language:"]');
    await input('[aria-label="Search Output Language"]', "Turkish");
    await assert(`${size} language filters by name`, "[...document.querySelectorAll('.model-select-option')].some(e=>e.textContent==='Turkish (tr)') && document.querySelectorAll('.model-select-option').length===2");
    await capture(`${size}-language-picker`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }, sid);
    await assert(`${size} language selection stores code and marks dirty`, "document.querySelector('button[aria-label^=\"Output Language:\"]').textContent.includes('Turkish (tr)') && !document.querySelector('.config-save').disabled");
    await section("Background models");
    await click('[aria-label="Primary variant"]');
    await assert(`${size} variant choices match selected model`, "[...document.querySelectorAll('.model-select-option')].map(e=>e.textContent.trim()).join('|')==='Use harness default|low|high|adaptive'");
    await capture(`${size}-variant-picker`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sid);
    await click('.model-chain-item .model-select-trigger');
    await assert(`${size} fallback dropdown is portaled and in viewport`, "(()=>{const e=document.querySelector('.model-select-dropdown'),r=e.getBoundingClientRect();return !e.closest('.config-editor') && r.width>=320 && r.height>100 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()");
    await capture(`${size}-fallback-dropdown`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }, sid);
    await click('[aria-label="Fallback variant"]');
    await input('[aria-label="Search Fallback variant"]', "operator-custom");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }, sid);
    await assert(`${size} unknown variant accepts a typed value`, "document.querySelector('[aria-label=\"Fallback variant\"]').textContent.includes('operator-custom')");
    await section("Prompt surface");
    await evaluate("document.querySelector('#description-ctx_search').scrollIntoView({block:'center'});window.__toolDefault=document.querySelector('#description-ctx_search').value");
    await input('#description-ctx_search', "Operator search description");
    await assert(`${size} tool override is editable`, "document.querySelector('#description-ctx_search').value==='Operator search description'");
    await click('.config-tool-row:has(#description-ctx_search) button');
    await assert(`${size} reset restores actual built-in description`, "document.querySelector('#description-ctx_search').value===window.__toolDefault");
    await evaluate("[...document.querySelectorAll('.config-list-editor button')].find(b=>b.textContent.includes('Add route')).click()");
    await frame();
    await click('.config-list-editor > .model-select .model-select-trigger');
    await input('.model-select-search', "openai/*");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }, sid);
    await evaluate("(()=>{const select=document.querySelector('.config-route-table tbody tr:last-child select');select.value='light';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await assert(`${size} wildcard route form supports light preset`, "document.querySelector('.config-route-table tbody tr:last-child').textContent.includes('openai/*') && document.querySelector('.config-route-table tbody tr:last-child select').value==='light'");
    await section("Advanced");
    await input('[aria-label="New Pi subagent extension"]', "extensions/operator-tools.ts");
    await evaluate("document.querySelector('.config-list-editor form').requestSubmit()");
    await assert(`${size} extension list adds a full-width row`, "document.querySelector('[aria-label=\"Pi Subagent Extensions entry 3\"]').value==='extensions/operator-tools.ts'");
    await section("Memory & search");
    await assert(`${size} endpoint and model inputs show realistic values`, "(()=>{const inputs=[...document.querySelectorAll('input')].filter(e=>e.value.includes('openrouter.ai') || e.value.includes('qwen3-embedding'));return inputs.length===2 && inputs.every(e=>e.clientWidth>300 && e.scrollWidth<=e.clientWidth)})()");
    await click('.config-save');
    writeFileSync(join(root, `${size}-saved-fixture.jsonc`), await evaluate<string>("window.__fixtureSaved ?? 'SAVE NOT REACHED'"));
    await assert(`${size} save preserves fixture JSONC and language code`, "window.__fixtureSaved.includes('\\r\\n') && window.__fixtureSaved.includes('// Operator') && window.__fixtureSaved.includes('\"keep_spacing\" :  42,') && window.__fixtureSaved.includes('\"language\": \"tr\"') && window.__fixtureSaved.trimEnd().endsWith(',\\r\\n}')");
    await assert(`${size} forms write overrides but not default descriptions`, "window.__fixtureSaved.includes('\"openai/*\": \"light\"') && window.__fixtureSaved.includes('operator-custom') && window.__fixtureSaved.includes('extensions/operator-tools.ts') && !window.__fixtureSaved.includes('tool_descriptions')");
    await section("Advanced");
    await assert(`${size} auto update inherits on without undefined labels`, "!document.querySelector('.config-editor').textContent.includes('Default: undefined') && [...document.querySelectorAll('.config-field')].find(e=>e.getClientRects().length&&e.textContent.includes('Auto Update')).textContent.includes('Default: on')");
    await assert(`${size} only fixture commands used`, "!window.__fixtureCalls.includes('test_embedding_endpoint')");
  }
  writeFileSync(join(root, "report.json"), JSON.stringify({ browser: version.product, checks, screenshots, layoutMeasurements }, null, 2));
  console.log(`PASS: ${checks.length} browser checks; ${screenshots.length} screenshots in ${root}`);
} finally {
  socket?.close();
  chrome.kill(); vite.kill();
  await Promise.all([chrome.exited, vite.exited]);
}
