import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "../../shared/test-temp-dir";

for (const host of ["oc1", "oc2"]) {
    for (const point of ["ordinary-deferred", "before-dirty", "temp-synced", "dirty", "returned"]) {
        test.skipIf(process.platform === "win32")(
            `independent SIGKILL ${host}: ${point}`,
            () => {
                const { dir: root, cleanup } = createTestTempDir("mc-oc-sigkill-review-");
                const path = (relative: string) => JSON.stringify(join(import.meta.dir, relative));
                const common = `
import { writeFileSync } from 'node:fs';
import { listOpenFiles } from ${path("../../shared/test-open-files.ts")};
import { openDatabase } from ${path("../../features/magic-context/storage-db.ts")};
import { createTagger } from ${path("../../features/magic-context/tagger.ts")};
import { createTransform } from ${path("transform.ts")};
import { createMessagesTransformHandler } from ${path("../../plugin/messages-transform.ts")};
import { loadPersistedLkgSlot } from ${path("lkg-persist.ts")};
import { setCtxReduceRegisteredGlobally } from ${path("ctx-reduce-availability.ts")};
import { Database } from ${path("../../shared/sqlite.ts")};
import { adaptPayload } from ${path("../../v2/hooks/payload.ts")};
const root = ${JSON.stringify(root)};
const id = 'independent-killed-${host}';
const db = openDatabase(root + '/context.db');
if (!db) throw new Error('Disposable context.db unavailable');
db.exec('PRAGMA busy_timeout=0');
setCtxReduceRegisteredGlobally(true);
const model = {providerID:'openai',modelID:'gpt-4.1'};
const transform = createTransform({db,tagger:createTagger(),scheduler:{shouldExecute:()=> 'defer'},
 directory:root,storeGeneration:${JSON.stringify(host === "oc2" ? "v2" : "v1")},
 contextUsageMap:new Map(),historyRefreshSessions:new Set(),pendingMaterializationSessions:new Set(),lastHeuristicsTurnId:new Map(),historianRunnable:false,
 protectedTokens:0,clearReasoningAge:1000,memoryConfig:{enabled:false},injectDocs:false,
 liveModelBySession:new Map([[id,model]])});
const handler = createMessagesTransformHandler({magicContext:{'experimental.chat.messages.transform':transform}});
const message = (n,role,text) => ({info:{id:'m'+n,role,sessionID:id,model,tools:{ctx_reduce:true},time:{created:n+1},...(role==='assistant'?{finish:'stop'}:{})},parts:[{type:'text',text}]});
const head = [message(0,'user','old request')];
const raw = [...head,message(1,'assistant','new served tail'),message(2,'user','new question')];
const pass = async (messages) => {
 if (${JSON.stringify(host)} === 'oc2') {
  const draft = {sessionID:id,model:{providerID:'openai',id:'gpt-4.1',limit:{context:200000}},agent:'build',system:[],options:{},tools:{ctx_reduce:{description:'reduce',input:{type:'object'}}},messages:messages.map(m=>({id:m.info.id,role:m.info.role,content:m.parts}))};
  const bridge = adaptPayload(draft); await handler({},bridge); bridge.commit(); return draft;
 }
 const output = {messages:structuredClone(messages)}; await handler({},output); return output;
};
const isolate = () => {
  const files = listOpenFiles();
  // A missing inventory cannot establish live-store isolation before killing the host.
  if(!files.available) throw new Error(files.reason);
  if(/\\/(?:\\.local\\/share\\/opencode|\\.local\\/share\\/cortexkit\\/magic-context|\\.config\\/(?:opencode|cortexkit))\\//.test(files.paths.join('\\n'))) throw new Error('Live-store isolation not proved');
 console.log('OC_LSOF pid=' + process.pid + ' forbidden=0');
};
const kill = () => process.kill(process.pid,'SIGKILL');
`;
                const run = (code: string) =>
                    spawnSync(process.execPath, ["--eval", common + code], {
                        env: {
                            ...process.env,
                            OPENCODE_DB: undefined,
                            XDG_DATA_HOME: root,
                            XDG_CONFIG_HOME: root,
                            MAGIC_CONTEXT_STORAGE_DIR: join(root, "store"),
                            MAGIC_CONTEXT_TEST_DATA_DIR: root,
                            BUN_JSC_useOMGJIT: "0",
                        },
                        encoding: "utf8",
                        timeout: 45000,
                        windowsHide: true,
                    });
                try {
                    const killed = run(`
await pass(head); await new Promise(resolve=>setImmediate(resolve));
const old = loadPersistedLkgSlot(db,id);
if(!old) throw new Error('No seeded durable snapshot');
writeFileSync(root+'/before.json',JSON.stringify(old.jsonPrefix));
isolate();
${
    point === "ordinary-deferred"
        ? ""
        : `const {__test:fence} = await import(${path("lkg-recovery-fence.ts")});
${point === "before-dirty" ? "fence.setIoObserver(op=>{if(op==='mutex') kill();});" : ""}
${point === "dirty" || point === "temp-synced" ? `fence.setObserver(phase=>{if(phase===${JSON.stringify(point)}) kill();});` : ""}
const locker = new Database(root+'/context.db'); locker.exec('BEGIN IMMEDIATE');`
}
const result = await pass(raw);
writeFileSync(root+'/model-saw.json',JSON.stringify(result));
kill();
`);
                    expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL");
                    const restart = run(`
const slot = loadPersistedLkgSlot(db,id);
isolate();
${point === "ordinary-deferred" ? "const trusted=true;" : `const {hasCleanLkgRecoveryFence} = await import(${path("lkg-recovery-fence.ts")}); const trusted=hasCleanLkgRecoveryFence(id,slot);`}
console.log('OC_RESTART '+JSON.stringify({trusted, prefix:slot?.jsonPrefix}));
`);
                    expect(restart.status, restart.stderr).toBe(0);
                    const line = restart.stdout
                        .split("\n")
                        .find((line) => line.startsWith("OC_RESTART "));
                    if (!line) throw new Error(restart.stdout + restart.stderr);
                    const proof = JSON.parse(line.slice(11));
                    expect(proof.prefix).toBe(
                        JSON.parse(readFileSync(join(root, "before.json"), "utf8")),
                    );
                    expect(proof.trusted).toBe(
                        ["ordinary-deferred", "before-dirty", "temp-synced"].includes(point),
                    );
                    if (["ordinary-deferred", "returned"].includes(point))
                        expect(readFileSync(join(root, "model-saw.json"), "utf8")).toContain(
                            "new served tail",
                        );
                    console.log(
                        `OC_SIGKILL_PROOF host=${host} point=${point} signal=${killed.signal} oldSlotRetained=true restartTrusted=${proof.trusted}`,
                    );
                } finally {
                    cleanup();
                }
            },
            100000,
        );
    }
}

for (const point of ["committed", "before-clean", "after-clean"]) {
    test.skipIf(process.platform === "win32")(
        `independent SIGKILL shared publication: ${point}`,
        () => {
            const { dir: root, cleanup } = createTestTempDir("mc-publication-sigkill-");
            const path = (relative: string) => JSON.stringify(join(import.meta.dir, relative));
            const common = `
import { Database } from 'bun:sqlite';
import { LKG_SLOTS_DDL, LKG_SLOT_CHUNKS_DDL } from ${path("../../features/magic-context/migration-v94-write-split.ts")};
import { loadPersistedLkgSlot, saveLkgSlotToDb } from ${path("lkg-persist.ts")};
import { __test, markLkgRecoveryDirty, hasCleanLkgRecoveryFence } from ${path("lkg-recovery-fence.ts")};
const db = new Database(${JSON.stringify(join(root, "context.db"))});
db.exec('PRAGMA journal_mode=WAL;');
db.exec(LKG_SLOTS_DDL + LKG_SLOT_CHUNKS_DDL + "CREATE TABLE IF NOT EXISTS session_meta(session_id TEXT PRIMARY KEY,trailing_blank_decisions TEXT DEFAULT '');");
const slot = {jsonPrefix:'[{"text":"old"}]',inputIdSeq:['one'],inputContentDigests:['d'],lastInputMessageId:'one',modelKey:'p/m',providerKey:'p',capturedAt:1};
`;
            const run = (code: string) =>
                spawnSync(process.execPath, ["--eval", common + code], {
                    env: {
                        ...process.env,
                        OPENCODE_DB: undefined,
                        XDG_DATA_HOME: root,
                        XDG_CONFIG_HOME: root,
                        MAGIC_CONTEXT_STORAGE_DIR: root,
                        MAGIC_CONTEXT_TEST_DATA_DIR: root,
                    },
                    encoding: "utf8",
                    timeout: 30000,
                    windowsHide: true,
                });
            try {
                const killed = run(`
if(!saveLkgSlotToDb(db,'s',slot)) throw new Error('Seed save failed');
markLkgRecoveryDirty({sessionId:'s',slot:loadPersistedLkgSlot(db,'s'),processLocalProof:false});
__test.setObserver(phase=>{if(phase===${JSON.stringify(point === "before-clean" ? "clean" : point)}) process.kill(process.pid,'SIGKILL');});
saveLkgSlotToDb(db,'s',{...slot,jsonPrefix:'[{"text":"matching healthy rebuild"}]',capturedAt:2},undefined,{rebuild:true});
${point === "after-clean" ? "process.kill(process.pid,'SIGKILL');" : ""}
throw new Error('Selected publication boundary not reached');
`);
                expect(killed.signal, killed.stderr).toBe("SIGKILL");
                const restarted = run(
                    "const saved=loadPersistedLkgSlot(db,'s'); console.log('PUBLICATION '+JSON.stringify({prefix:saved?.jsonPrefix,trusted:hasCleanLkgRecoveryFence('s',saved)}));",
                );
                expect(restarted.status, restarted.stderr).toBe(0);
                const line = restarted.stdout
                    .split("\n")
                    .find((line) => line.startsWith("PUBLICATION "));
                if (!line) throw new Error(restarted.stdout + restarted.stderr);
                const proof = JSON.parse(line.slice(12));
                expect(proof.prefix).toBe('[{"text":"matching healthy rebuild"}]');
                expect(proof.trusted).toBe(point === "after-clean");
            } finally {
                cleanup();
            }
        },
        90000,
    );
}
