import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../plugin/src/shared/sqlite";
import { setHarness } from "../../plugin/src/shared/harness";
import { closeDatabase, openDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { createTagger } from "../../plugin/src/features/magic-context/tagger";
import { tagMessages, type MessageLike } from "../../plugin/src/hooks/magic-context/tag-messages";
import { ensureMessagesIndexed } from "../../plugin/src/features/magic-context/message-index";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { readAllV2RawMessagesForConversion } from "../../plugin/src/v2/hooks/store";
import { V2StoreReader } from "../../plugin/src/v2/store-reader";
import { MockProvider } from "../src/mock-provider/server";
import { isolation, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../src/opencode2-runner/spawn";

const version = process.argv[2] ?? "2.0.22";
const cli = resolve(`target/issue-632-hosts/${version}/node_modules/@opencode/cli/bin/opencode.exe`);
const fixture = isolation();
assert(fixture.root.startsWith(join(process.env.TMPDIR!, "mc-opencode2-")));
const evidence = join(process.env.TMPDIR!, "evidence", version);
mkdirSync(evidence, { recursive: true });
const probe = join(fixture.root, "observer");
mkdirSync(probe);
const trace = join(fixture.root, "compaction.jsonl");
const observerSource = join(fixture.root, "observer-source.ts");
writeFileSync(observerSource, `import {appendFileSync} from "node:fs";
import {encodeNative} from ${JSON.stringify(resolve("packages/plugin/src/v2/fold/native-codec.ts"))};
export default {id:"issue-632-observer", async setup(context) {
  await context.session.hook("context", draft => {
    let encodedBytes, error;
    const checkpointText = draft.messages.flatMap(m=>m.content).map(p=>p.text).find(t=>typeof t === "string" && t.includes("<conversation-checkpoint>"));
    const recentBlock = checkpointText?.match(/<recent-context>[\\s\\S]*?<\\/recent-context>/)?.[0];
    try { encodedBytes=Buffer.byteLength(JSON.stringify(encodeNative(draft.messages))); } catch (e) { error=String(e); }
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({type:"native",sessionID:draft.sessionID,at:Date.now(),messages:draft.messages.length,encodedBytes,checkpointUtf8Bytes:checkpointText ? Buffer.byteLength(checkpointText) : 0,recentContextUtf8Bytes:recentBlock ? Buffer.byteLength(recentBlock) : 0,error})+"\\n");
  });
  await context.session.hook("compaction", async draft => { appendFileSync(${JSON.stringify(trace)}, JSON.stringify({type:"compaction",sessionID:draft.sessionID,at:Date.now()})+"\\n"); await new Promise(resolve=>setTimeout(resolve,250)); });
}};`);
const observerBundle = await Bun.build({ entrypoints: [observerSource], target: "bun" });
assert(observerBundle.success);
writeFileSync(join(probe, "server.js"), await observerBundle.outputs[0]!.text());
const mock = new MockProvider();
const provider = await mock.start();
mock.setDefault({ text: "deterministic reply", usage: { input_tokens: 100, output_tokens: 10 } });
const options = {
  cli, existingIsolation: fixture, existingMock: { mock, baseURL: provider.baseURL },
  compactionAuto: false, modelContextLimit: 200000, modelOutputLimit: 1024,
  prePlugin: probe,
  magicContextConfig: {
    cache_ttl: "30s", protected_tokens: 4000, temporal_awareness: false,
    historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false },
  },
};
let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
const clientFor = () => OpenCode.make({ baseUrl: host!.url, headers: { authorization: `Basic ${btoa(`opencode:${host!.password}`)}` } });
const dbPath = join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!);
const samples: unknown[] = [];
const sample = () => {
  const paths = inspectOpenFiles(host!.pid!, fixture.root, host!.env).filter(p => /\.db(?:-wal|-shm)?$/.test(p));
  assert(paths.length > 0);
  assert(paths.every(p => p.startsWith(fixture.root + "/")));
  samples.push({ pid: host!.pid, paths });
};
const readRows = () => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare("SELECT id,type,seq,time_created,data FROM session_message WHERE session_id=? ORDER BY seq").all(sessionID) as Array<{id:string;type:string;seq:number;time_created:number;data:string}>; }
  finally { db.close(); }
};
let sessionID = "";
let stage = "initial boot";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const turns: Record<string, unknown> = {};
const wire: Record<string, string> = {};
try {
  fixture.env.MC_OC2_INVISIBLE_FOLD = "0";
  host = await spawnOpencode2(options);
  let client = clientFor();
  await waitForPluginActive(client, fixture.cwd);
  sessionID = (await client.session.create({ title: "issue-632 25k verification", location: { directory: fixture.cwd }, model: { providerID: "openai", id: "mock-model" } })).id;
  sample();
  await host.stopHost();
  const db = new Database(dbPath);
  try {
    const put = db.prepare("INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)");
    const start = Date.now() - 60000;
    db.transaction(() => {
      for (let i = 0; i < 25000; i++) {
        const assistant = i % 2 === 1;
        const data = assistant ? {
          agent: "build", model: { providerID: "openai", id: "mock-model" },
          content: [{ type: "text", text: `synthetic answer ${i}` }], finish: "stop", cost: 0,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: start + i, completed: start + i + 1 },
        } : { text: `synthetic user ${i}`, time: { created: start + i } };
        if (i === 24997 && "content" in data) {
          for (const status of ["completed", "error"] as const) {
            (data.content as unknown[]).push({ type: "tool", id: `call_seed_${status}`, name: "read",
              state: { status, input: { path: join(fixture.cwd, `${status}.txt`) },
                content: [{ type: "text", text: `PRESERVED_${status}_RESULT café` }],
                ...(status === "error" ? { error: { type: "ToolError", message: "PRESERVED_ERROR_TEXT café" } } : {}) },
              time: { created: start + i, completed: start + i + 1 } });
          }
        }
        put.run(`msg_seed_${String(i).padStart(6, "0")}`, sessionID, assistant ? "assistant" : "user", i + 1, start + i, start + i, JSON.stringify(data));
      }
      const updated = db.prepare("UPDATE event_sequence SET seq=25000 WHERE aggregate_id=?").run(sessionID);
      assert.equal(updated.changes, 1, "advance the synthetic session's host event sequence");
    })();
  } finally { db.close(); }
  assert.equal(readRows().length, 25000);
  setHarness("opencode2");
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "MAGIC_CONTEXT_LOG_PATH"])
    process.env[key] = fixture.env[key];
  process.env.OPENCODE_DB = dbPath;
  const contextDb = openDatabase(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
  assert(contextDb);
  const rawRows = readAllV2RawMessagesForConversion(() => new V2StoreReader(dbPath), sessionID);
  const messages: MessageLike[] = rawRows.map(row => ({ info: { id: row.id, role: row.role, sessionID }, parts: structuredClone(row.parts) }));
  const tagger = createTagger();
  tagger.initFromDb(sessionID, contextDb);
  // Prewarm only disposable fixture data, so the timed host step is not a first-import benchmark.
  contextDb.transaction(() => tagMessages(sessionID, messages, tagger, contextDb, { skipPrefixInjection: true })).immediate();
  ensureMessagesIndexed(contextDb, sessionID, () => rawRows);
  const summary = "Synthetic history summarized through raw ordinal 24000.";
  appendCompartments(contextDb, sessionID, [{ sequence: 0,
    startMessage: rawRows[0]!.ordinal, endMessage: rawRows[23999]!.ordinal,
    startMessageId: rawRows[0]!.id, endMessageId: rawRows[23999]!.id,
    startBlockIndex: null, endBlockIndex: null, title: "Seeded first 24k",
    content: summary, p1: summary, importance: 50, episodeType: null }]);
  console.log("PREWARM " + JSON.stringify({ rows: rawRows.length, tags: contextDb.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id=?").get(sessionID) }));
  closeDatabase();
  const snapshot = join(process.env.TMPDIR!, `snapshot-${version}`);
  cpSync(fixture.root, snapshot, { recursive: true });
  for (const branch of ["control", "fold", "race"]) {
    const fold = branch !== "control";
    let pendingRace: Promise<unknown> | undefined;
    let raceStarted = 0;
    let raceOffset = 0;
    mock.script([0, 1, 2, 3, 4].map(n => ({
      openaiOutput: [{type:"message",id:`msg_issue632_turn_${n}`,role:"assistant",content:[{type:"output_text",text:"deterministic reply",annotations:[],logprobs:[]}]}],
      usage: {input_tokens:100,output_tokens:10},
    })));
    stage = fold ? "fold branch boot" : "control branch boot";
    console.log("PROBE_STAGE " + JSON.stringify({ stage, root: fixture.root }));
    if (fold) {
      rmSync(fixture.root, { recursive: true });
      cpSync(snapshot, fixture.root, { recursive: true });
    }
    fixture.env.MC_OC2_INVISIBLE_FOLD = fold ? "1" : "0";
    host = await spawnOpencode2(options);
    client = clientFor();
    await waitForPluginActive(client, fixture.cwd);
    sample();
    for (const [index, text] of ["establish managed baseline", "warm continuation before idle", "identical continuation", "warm continuation after fold", "first continuation after restart"].entries()) {
      if (index === 4) {
        await host.stopHost();
        host = await spawnOpencode2(options);
        client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        sample();
      }
      const key = `${branch}-${index}`;
      stage = key;
      console.log("PROBE_STAGE " + key);
      const offset = index === 2 && pendingRace ? raceOffset : mock.requests().length;
      const started = index === 2 && pendingRace ? raceStarted : performance.now();
      if (index === 2 && pendingRace) await pendingRace;
      else await client.session.prompt({ sessionID, text });
      await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(180000) });
      const ms = performance.now() - started;
      console.log("PROBE_TURN " + JSON.stringify({ key, ms, requests: mock.requests().length }));
      const requests = mock.requests().slice(offset);
      if (requests.length !== 1) console.log("PROBE_FAILURE " + JSON.stringify({ key, root: fixture.root, stderr: host.stderr().split("\n").filter(line => /level=ERROR/.test(line)), log: host.pluginLog() }));
      assert.equal(requests.length, 1, `one primary request on ${key}`);
      const request = requests[0]!;
      assert(request.rawBody);
      wire[key] = request.rawBody;
      writeFileSync(join(evidence, `${key}.json`), request.rawBody);
      turns[key] = { ms, utf8Bytes: Buffer.byteLength(request.rawBody), bytes: request.rawBody.length, sha256: sha(request.rawBody), receivedAt: request.receivedAt, responseCompletedAt: request.responseCompletedAt };
      if (index === 1) {
        const warmDeadline = Date.now() + 1000;
        while (Date.now() < warmDeadline) {
          assert(!readRows().some(row => row.type === "compaction"), "no fold while cache lifetime is warm");
          await Bun.sleep(50);
        }
        const clockDb = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {readonly:true});
        let frozen: {cache_ttl:string;last_response_time:number};
        try { frozen = clockDb.prepare("SELECT cache_ttl,last_response_time FROM session_meta WHERE session_id=?").get(sessionID) as typeof frozen; }
        finally { clockDb.close(); }
        assert.equal(frozen.cache_ttl,"30s");
        assert(frozen.last_response_time >= request.responseCompletedAt!, "idle timer uses this completed response");
        turns[`${branch}-idle-clock`] = frozen;
        const deadline = Date.now() + (fold ? 90000 : 30000);
        while (Date.now() < deadline) {
          if (branch === "race" && existsSync(trace) && readFileSync(trace,"utf8").includes('"type":"compaction"')) {
            raceStarted = performance.now();
            raceOffset = mock.requests().length;
            pendingRace = client.session.prompt({ sessionID, text: "identical continuation" });
            break;
          }
          if (readRows().some(row => row.type === "compaction" && JSON.parse(row.data).status === "completed")) break;
          await Bun.sleep(20);
        }
        if (branch === "race") assert(pendingRace, "turn starts while compaction hook is running");
        else if (fold) assert.equal(readRows().filter(row => row.type === "compaction" && JSON.parse(row.data).status === "completed").length, 1, "one completed fold after idle cache lifetime");
      }
    }
    sample();
    const rows = readRows();
    const cuts = rows.filter(row => row.type === "compaction");
    if (fold) {
      const frozen = turns[`${branch}-idle-clock`] as {last_response_time:number};
      assert(cuts.every(cut=>cut.time_created > frozen.last_response_time + 30000), "every fold starts strictly after the frozen idle TTL");
    }
    turns[`${branch}-state`] = {
      seedHash: sha(JSON.stringify(rows.filter(row=>row.id.startsWith("msg_seed_")).map(row=>({id:row.id,type:row.type,seq:row.seq,data:row.data})))),
      seedRows: rows.filter(row=>row.id.startsWith("msg_seed_")).length,
      rows: rows.length,
      rowsAfterCut: cuts.length ? rows.filter(row => row.seq > cuts.at(-1)!.seq).length : rows.length,
      cuts: cuts.map(row => {
        const data = JSON.parse(row.data);
        return { id: row.id, seq: row.seq, time_created: row.time_created, status: data.status,
          summaryBytes: data.summary?.length, summarySHA256: sha(data.summary ?? ""), recentBytes: data.recent?.length, recentUtf8Bytes: Buffer.byteLength(data.recent ?? "") };
      }),
      foldLog: host.pluginLog().split("\n").filter(line => /v2 host fold:|cacheTtl=|HARD fold decision/.test(line)),
    };
    writeFileSync(join(evidence, `${branch}.log`), host.pluginLog());
    writeFileSync(join(evidence, `${branch}.stderr.log`), host.stderr());
    if (fold && existsSync(trace)) turns.compactionHooks = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await host.stopHost();
  }
  const diffs = [0, 1, 2, 3, 4].map(index => {
    const a = wire[`control-${index}`]!;
    const b = wire[`fold-${index}`]!;
    let first = 0;
    while (first < Math.min(a.length, b.length) && a[first] === b[first]) first++;
    return { index, equal: a === b, controlBytes: a.length, foldBytes: b.length, firstDiff: a === b ? null : first, controlWindow: a === b ? "" : a.slice(Math.max(0, first - 150), first + 500), foldWindow: a === b ? "" : b.slice(Math.max(0, first - 150), first + 500) };
  });
  const result = { version, cli, root: fixture.root, sessionID, cacheTTLms: 30000, seededRows: 25000, turns, diffs, samples };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log("ISSUE632_RESULT " + JSON.stringify(result));
  const cuts = (turns["fold-state"] as { cuts: unknown[] }).cuts;
  assert.equal(cuts.length, 1, "trigger rule: exactly one automatic fold after idle expiry");
  for (const branch of ["fold", "race"]) {
    const state = turns[`${branch}-state`] as { seedRows: number; seedHash: string; cuts: unknown[] };
    assert.equal(state.seedRows, 25000, `${branch}: no source row lost`);
    assert.equal(state.seedHash, (turns["control-state"] as {seedHash:string}).seedHash, `${branch}: every source row unchanged`);
    assert.equal(state.cuts.length, 1, `${branch}: exactly one fold`);
    for (const index of [0,1,2,3,4]) assert.equal(wire[`${branch}-${index}`], wire[`control-${index}`], `${branch}: provider bytes after fold/restart ${index}`);
  }
  for (const diff of diffs) assert.equal(diff.equal, true, `request bytes for continuation ${diff.index}`);
} catch (error) {
  writeFileSync(join(evidence, "host.stderr.log"), host?.stderr() ?? "");
  writeFileSync(join(evidence, "host.plugin.log"), host?.pluginLog() ?? "");
  const a = wire["control-0"], b = wire["fold-0"];
  let at = 0;
  if (a && b) while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
  console.log("PROBE_ERROR " + JSON.stringify({ stage, root: fixture.root, error: String(error), requests: mock.requests().length, turns,
    baselineDiff: a && b ? { equal: a === b, firstDiff: a === b ? null : at, controlSHA: sha(a), foldSHA: sha(b), controlWindow: a.slice(Math.max(0, at - 120), at + 240), foldWindow: b.slice(Math.max(0, at - 120), at + 240) } : null,
    observations: existsSync(trace) ? readFileSync(trace,"utf8").trim().split("\n").map(line=>JSON.parse(line)) : [], samples,
    cutCount: sessionID ? readRows().filter(row => row.type === "compaction").length : null,
    stderr: host?.stderr().split("\n").filter(line => /level=ERROR/.test(line)).slice(-4),
    log: host?.pluginLog().split("\n").filter(line => /v2 host fold:|transform scheduler:|transform completed|HARD fold decision|native.*fold|unavailable/.test(line)).slice(-20) }));
  throw error;
} finally {
  await host?.stopHost();
  await mock.stop();
}
