// Generate/check agent-fragments-golden.json using composeSoftMemoryUpdates,
// the production memory-delta renderer shared by the TypeScript and Pi plugins.
import { Database } from "bun:sqlite";
import { composeSoftMemoryUpdates } from "../../../../packages/plugin/src/hooks/magic-context/inject-compartments";
import type { AppliedProjection } from "../../../../packages/plugin/src/features/magic-context/memory/applied-projection";
import { renderAddedFragmentLine, renderUpdatedFragmentLine, renderRemovedFragmentLine, renderSupersededFragmentLine } from "../../../../packages/plugin/src/features/magic-context/memory/agent-fragments";

const db = new Database(":memory:");
db.exec(`CREATE TABLE memory_agent_fragments(id INTEGER PRIMARY KEY,session_id TEXT,harness TEXT,project_path TEXT,operation_key TEXT,memory_ids_json TEXT,current_id INTEGER,lines TEXT,visible_texts_json TEXT)`);
const option = (name: string) => {
    const index=process.argv.indexOf(name);
    return index<0 ? undefined : process.argv[index+1];
};
const file = option("--output") ?? new URL("./agent-fragments-golden.json",import.meta.url);
const cases: unknown[] = [];
let seed = Number(option("--seed") ?? 0x54c0ffee)>>>0;
const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
const fresh = (): AppliedProjection => ({generation:1,hardMemoryBlock:JSON.stringify({updateLines:[],newMemories:""}),fragmentWatermark:0,committed:[],legacy:false});
let projection = fresh();
let nextId = 0;
for (let step=0;step<Number(option("--steps") ?? 160);step++) {
    const pass = step<4 ? "soft" : ["soft","defer","hard"][random()%3];
    const pending = [];
    if (pass === "hard") { db.exec("DELETE FROM memory_agent_fragments"); projection=fresh(); }
    const before = structuredClone(projection);
    if (pass === "soft") {
        for (let index=0;index<1+random()%6;index++) {
            const id=++nextId;
            const text = step === 0 ? "literal & <claim> \"quoted\" 🦀" : "immutable claim ".repeat(1+random()%90);
            const kind = random()%4;
            const lines = kind===0 ? [renderRemovedFragmentLine(id)] : kind===1 ? [renderSupersededFragmentLine(id,id+100),renderAddedFragmentLine(id+100,"CONSTRAINTS",text)] : [kind===2 ? renderUpdatedFragmentLine(id,"CONSTRAINTS",text) : renderAddedFragmentLine(id,"CONSTRAINTS",text)];
            const memoryIds=kind===1 ? [id,id+100] : [id];
            const currentId=kind===0 ? null : kind===1 ? id+100 : id;
            const visibleTexts=currentId===null ? [] : [{id:currentId,text}];
            const fragment={id,operationKey:`op-${id}`,memoryIds,currentId,lines,visibleTexts};
            pending.push(fragment);
            db.prepare("INSERT INTO memory_agent_fragments VALUES(?, 'ses','opencode','/repo',?,?,?,?,?)").run(id,fragment.operationKey,JSON.stringify(memoryIds),currentId,lines.join("\n"),JSON.stringify(visibleTexts));
        }
    }
    const memoryBudgetTokens=step===0 ? 8000 : [0,100,500,1200,8000][random()%5];
    const historyBudgetTokens=60000;
    const independentTokens=random()%1000;
    const m0Tokens=[0,499,500,8000][random()%4];
    let block="";
    if (pass==="soft") { const result=composeSoftMemoryUpdates({db:db as never,sessionId:"ses",projection,memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens:()=>m0Tokens}); projection=result.projection;block=result.block; }
    cases.push({pass,before,pending,memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens,block,committed:projection.committed});
}
// Fixed operation goldens are also exercised through the real Rust module facade.
// Each scenario begins with memory IDs 1 and 2 folded into both sessions' heads.
for (const facadeAction of ["update", "merge", "archive", "write"] as const) {
    db.exec("DELETE FROM memory_agent_fragments");
    const before=fresh();
    const content=facadeAction==="update" ? "updated rule" : facadeAction==="merge" ? "merged rule" : "new additive memory";
    const memoryIds=facadeAction==="merge" ? [1,2,3] : facadeAction==="write" ? [3] : [1];
    const currentId=facadeAction==="archive" ? null : facadeAction==="update" ? 1 : 3;
    const lines=facadeAction==="archive" ? [renderRemovedFragmentLine(1)] : facadeAction==="merge" ? [renderSupersededFragmentLine(1,3),renderSupersededFragmentLine(2,3),renderAddedFragmentLine(3,"CONSTRAINTS",content)] : [facadeAction==="update" ? renderUpdatedFragmentLine(1,"CONSTRAINTS",content) : renderAddedFragmentLine(3,"CONSTRAINTS",content)];
    const visibleTexts=currentId===null ? [] : [{id:currentId,text:content}];
    const fragment={id:1,operationKey:`facade-${facadeAction}`,memoryIds,currentId,lines,visibleTexts};
    db.prepare("INSERT INTO memory_agent_fragments VALUES(?, 'ses','opencode','/repo',?,?,?,?,?)").run(fragment.id,fragment.operationKey,JSON.stringify(memoryIds),currentId,lines.join("\n"),JSON.stringify(visibleTexts));
    const memoryBudgetTokens=8000, historyBudgetTokens=60000, independentTokens=0, m0Tokens=0;
    const result=composeSoftMemoryUpdates({db:db as never,sessionId:"ses",projection:before,memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens:()=>m0Tokens});
    cases.push({pass:"soft",facadeAction,content,before,pending:[fragment],memoryBudgetTokens,historyBudgetTokens,independentTokens,m0Tokens,block:result.block,m1:`<session-history-since>\n${result.block}\n</session-history-since>`,committed:result.projection.committed});
}
const rendered="[\n"+cases.map(item=>JSON.stringify(item)).join(",\n")+"\n]\n";
if (option("--input")) {
    const input=await Bun.file(option("--input")!).json();
    const output=[];
    for (const entry of input) {
        db.exec("DELETE FROM memory_agent_fragments");
        for (const fragment of entry.pending) {
            db.prepare("INSERT INTO memory_agent_fragments VALUES(?, 'ses','opencode','/repo',?,?,?,?,?)").run(fragment.id,fragment.operationKey,JSON.stringify(fragment.memoryIds),fragment.currentId,fragment.lines.join("\n"),JSON.stringify(fragment.visibleTexts));
        }
        const result=composeSoftMemoryUpdates({db:db as never,sessionId:"ses",projection:entry.before,memoryBudgetTokens:entry.memoryBudgetTokens,historyBudgetTokens:entry.historyBudgetTokens,independentTokens:entry.independentTokens,m0Tokens:()=>entry.m0Tokens});
        output.push({block:result.block,committed:result.projection.committed});
    }
    await Bun.write(file,JSON.stringify(output));
    console.log(`TS/Pi fragment parity: ${output.length} supplied pass cases generated`);
} else
if (process.argv.includes("--check")) {
    if (await Bun.file(file).text()!==rendered) throw new Error("Rust fragment golden differs from TS/Pi production output");
    console.log(`TS/Pi fragment parity: ${cases.length} fixed-seed pass cases checked`);
} else {
    await Bun.write(file,rendered);
    console.log(`TS/Pi fragment parity: ${cases.length} fixed-seed pass cases generated`);
}
