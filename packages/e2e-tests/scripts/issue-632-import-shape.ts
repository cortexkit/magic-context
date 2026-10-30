import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { Database } from "../../plugin/src/shared/sqlite";
import { prepareCompactionMarkerCandidates, injectCompactionMarker, closeCompactionMarkerDb } from "../../plugin/src/features/magic-context/compaction-marker";
import { MockProvider } from "../src/mock-provider/server";
import { conversionFixture, spawnOpencode1, SHARED_MOCK_MODEL_ID, SHARED_MOCK_PROVIDER_ID } from "../src/opencode2-runner/conversion-lane";
import { spawnOpencode2 } from "../src/opencode2-runner/spawn";

const artifacts = resolve(".cortexkit/internal-docs/investigations/issue-632-imported");
mkdirSync(artifacts,{recursive:true});
const fixture = conversionFixture("issue-632-imported-shape");
const mock = new MockProvider();
const provider = await mock.start();
mock.setDefault({text:"seed reply",usage:{input_tokens:100,output_tokens:10}});
let old: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
try {
    old = await spawnOpencode1({fixture,mock,mockBaseURL:provider.baseURL,
        magicContextConfig:{historian:{disable:true},dreamer:{disable:true},memory:{enabled:false}}});
    const client = createOpencodeClient({baseUrl:old.url});
    const sessionID = (await client.session.create({query:{directory:fixture.cwd}})).data!.id;
    const response = await client.session.prompt({path:{id:sessionID},query:{directory:fixture.cwd},body:{
        model:{providerID:SHARED_MOCK_PROVIDER_ID,modelID:SHARED_MOCK_MODEL_ID},parts:[{type:"text",text:"template seed"}],
    }});
    assert(!response.error);
    await old.stop(); old=undefined;
    const db = new Database(fixture.openCodeDbPath);
    const templates = db.prepare("SELECT data FROM message WHERE session_id=? ORDER BY time_created,id").all(sessionID) as Array<{data:string}>;
    const user = templates.map(r=>JSON.parse(r.data)).find(r=>r.role==="user");
    const assistant = templates.map(r=>JSON.parse(r.data)).find(r=>r.role==="assistant" && !r.summary);
    assert(user && assistant);
    const part = db.prepare("SELECT data FROM part WHERE session_id=? AND json_extract(data,'$.type')='text' LIMIT 1").get(sessionID) as {data:string};
    const textPart=JSON.parse(part.data);
    const start=Date.now()-400000;
    db.transaction(()=>{
        db.prepare("DELETE FROM part WHERE session_id=?").run(sessionID);
        db.prepare("DELETE FROM message WHERE session_id=?").run(sessionID);
        const putMessage=db.prepare("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)");
        const putPart=db.prepare("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)");
        for(let i=0;i<32000;i++) {
            const id=`msg_import_seed_${String(i).padStart(6,"0")}`;
            const at=start+i*10;
            const data={...(i%2 ? assistant:user),id,sessionID,time:{created:at,...(i%2 ? {completed:at+1}:{})},
                ...(i%2 ? {parentID:`msg_import_seed_${String(i-1).padStart(6,"0")}`}:{})};
            putMessage.run(id,sessionID,at,at,JSON.stringify(data));
            const pid=`prt_import_seed_${String(i).padStart(6,"0")}`;
            putPart.run(pid,id,sessionID,at,at,JSON.stringify({...textPart,id:pid,messageID:id,sessionID,text:`imported ${i%2 ? "answer":"user"} ${i}`}));
        }
    })();
    db.close();
    const previousDb=process.env.OPENCODE_DB;
    process.env.OPENCODE_DB=fixture.openCodeDbPath;
    try {
        assert(await prepareCompactionMarkerCandidates(sessionID));
        assert(injectCompactionMarker({sessionId:sessionID,endOrdinal:31739,endMessageId:"msg_import_seed_031738",
            summaryText:"[Compacted by magic-context — session history is managed by the plugin]",directory:fixture.cwd}));
    } finally {
        closeCompactionMarkerDb();
        if(previousDb===undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB=previousDb;
    }
    fixture.env.MC_OC2_HOST_FOLD_ROWS="0";
    host=await spawnOpencode2({cli:process.env.MC_E2E_OPENCODE2_CLI,existingIsolation:fixture,existingMock:{mock,baseURL:provider.baseURL},
        compactionAuto:false,modelContextLimit:1000000,modelOutputLimit:1024,
        magicContextConfig:{cache_ttl:"30s",historian:{disable:true},dreamer:{disable:true},memory:{enabled:false}}});
    await host.stopHost(); host=undefined;
    for (const path of [fixture.openCodeDbPath,fixture.contextDbPath]) {
        const checkpoint = new Database(path);
        checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        checkpoint.close();
    }
    const converted=new Database(fixture.openCodeDbPath,{readonly:true});
    const cuts=converted.prepare("SELECT id,type,seq,data FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq").all(sessionID) as Array<{id:string;type:string;seq:number;data:string}>;
    const count=converted.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id=?").get(sessionID);
    converted.close();
    const record={sessionID,root:fixture.root,cwd:fixture.cwd,db:fixture.openCodeDbPath,contextDb:fixture.contextDbPath,count,
        cuts:cuts.map(c=>({...c,data:JSON.parse(c.data)}))};
    writeFileSync(join(artifacts,"imported-shape.json"),JSON.stringify(record,null,2));
    console.log("IMPORTED_SHAPE",JSON.stringify(record));
    const exported=join(fixture.root,"export"); mkdirSync(join(exported,"opencode"),{recursive:true});
    const {copyFileSync,cpSync}=await import("node:fs");
    copyFileSync(fixture.openCodeDbPath,join(exported,"opencode/opencode.db"));
    cpSync(fixture.storageDir,join(exported,"cortexkit/magic-context"),{recursive:true});
    const archive=Bun.spawnSync(["tar","-czf",join(artifacts,"migrated-fixture.tar.gz"),"-C",exported,"."],{stdout:"inherit",stderr:"inherit"});
    assert.equal(archive.exitCode,0);
} finally {
    await old?.stop(); await host?.stopHost(); await mock.stop();
}
