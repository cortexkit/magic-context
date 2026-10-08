//! Byte oracle for the full-request engine and incremental host hook lane.
//! The frozen digest corpus was emitted by the pre-extraction full engine.
use super::*;
use crate::config::CacheTtlProvenance;
use hooks::answer::HookAnswer;

const SEEDS: [u64; 4] = [0x13a5_9910, 0x72be_041f, 0xcafe_8712, 0xd00d_4405];
const PASSES: usize = 24;
fn next(state: &mut u64) -> u64 { *state ^= *state << 13; *state ^= *state >> 7; *state ^= *state << 17; *state }
fn message(mid: &str, role: &str, parts: Value, ordinal: u64, completion: bool) -> Value {
    let created = ordinal as i64 * 301_000;
    let mut value = json!({"info":{"id":mid,"role":role,"time":{"created":created}},"parts":parts});
    if completion { value["info"]["time"]["completed"] = json!(created + 1_000); }
    value
}
fn corpus(seed: u64) -> Vec<Vec<Value>> {
    let mut random = seed;
    let mut ordinal = 1u64;
    (0..PASSES).map(|pass| {
        let count = if pass < 4 { 3 } else { (next(&mut random) % 3 + 1) as usize };
        (0..count).map(|slot| {
            ordinal += 1;
            let mid = format!("m{ordinal}");
            let choice = if pass < 4 { slot as u64 } else { next(&mut random) % 4 };
            let completed = next(&mut random) & 1 == 1;
            let parts = match choice {
                0 => json!([{"id":format!("{mid}-text"),"type":"text","text":"rust ownership borrowing"}]),
                1 => {
                    let output = if pass < 4 || next(&mut random) & 1 == 1 { "spent payload ".repeat(30_000) } else { "small output".into() };
                    json!([{"id":format!("{mid}-tool"),"type":"tool","tool":"read","callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":output}}])
                },
                2 => json!([{"id":format!("{mid}-a"),"type":"text","text":"§99§ response referencing §3§ inline"},{"id":format!("{mid}-tool"),"type":"tool","tool":"bash","callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":"small output"}},{"id":format!("{mid}-b"),"type":"text","text":"café 🦀 continuation"}]),
                _ => json!([{"id":format!("{mid}-a"),"type":"text","text":"first user block"},{"id":format!("{mid}-b"),"type":"text","text":"second user block"}]),
            };
            message(&mid, if choice == 0 || choice == 3 { "user" } else { "assistant" }, parts, ordinal, completed)
        }).collect()
    }).collect()
}
fn fixture(dir: &Path, memory_budget: f64, temporal: bool) -> (McHandler, String) {
    let h = super::host_tests::handler(dir);
    let mut binding = h.facade_binding(7).unwrap();
    binding.history_budget_tokens = 2_000_000.0;
    binding.config.memory_enabled = true;
    binding.config.memory_budget_tokens = memory_budget;
    binding.config.protected_tokens_user = Some(16_000);
    binding.config.temporal_awareness = temporal;
    binding.config.auto_search.min_prompt_chars = 0;
    binding.config.auto_search.score_threshold = 0.0;
    h.bind_route(7, binding.clone());
    let store = h.store.get().unwrap();
    let project = h.route_project(store, &binding).unwrap().key;
    for (id, text) in [(1,"rust ownership borrowing durable context"),(2,"separate archive subject"),(3,"unrelated fixture material")] { store.seed_memory(id,&project,"CONSTRAINTS",text,50).unwrap(); }
    (h,project)
}
fn request(messages: &[Value], search: bool) -> TransformRequest {
    let entries = messages.iter().enumerate().map(|(n,m)|compact::status::StatusMessage {ordinal:n as u64+1,mid:m["info"]["id"].as_str().unwrap().into(),message:m.clone()}).collect::<Vec<_>>();
    let decoded = super::super::codec_opencode::decode_messages(&entries).unwrap();
    decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"parity","messages":decoded.messages,"tool_present":true,"auto_search_enabled":search,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0,"geometry":{"usable_soft":4000000,"usable_hard":6000000,"absolute_wall":8000000,"derivation":"parity"}})).unwrap()
}
fn context<'a>(project: &'a str, memory_budget: f64, temporal: bool, now: i64) -> transform::ProducerContext<'a> {
    transform::ProducerContext {project_path:project,note_project_path:project,project_directory:"/nonexistent-docs",history_budget_tokens:2_000_000.0,memory_budget_tokens:memory_budget,user_profile_budget_tokens:0.0,memory_enabled:true,inject_docs:false,temporal_awareness:temporal,now_ms:now,execute_threshold_percentage:80.0,protected_tokens_floor:16_000,protected_tokens_provenance:"absolute",compaction_enabled:true,smart_drops:false,protected_tools:Default::default(),cache_ttl:"never".into(),cache_ttl_provenance:CacheTtlProvenance::Default,cache_ttl_policy:None,model_key:None,observed_last_response_at_ms:None,guidance_date:None,historian_active:false,wrapup_active:false,caveman_english_word_rules:true,injected_reductions:vec![]}
}
fn scalars(response: &transform::TransformResponse, mids: &BTreeSet<String>) -> BTreeMap<String,Vec<(usize,String)>> {
    response.messages().iter().filter_map(|m| {
        let mid = m.meta.harness_id.as_ref()?;
        if !mids.contains(mid) { return None; }
        let values = m.content.iter().enumerate().filter_map(|(i,b)|match &b.kind {
            mc_store::CkKind::Text{text}=>Some((i,text.clone())),
            mc_store::CkKind::ToolResult{output,..}=>match &output.kind {mc_store::CkOutputKind::Text{text}|mc_store::CkOutputKind::ErrorText{text}=>Some((i,text.clone())),_=>None},_=>None,
        }).collect();
        Some((mid.clone(),values))
    }).collect()
}
fn digest(values: &BTreeMap<String,Vec<(usize,String)>>) -> String { sha256_hex(&serde_json::to_vec(values).unwrap()) }
fn baseline() -> Value { message("m1","user",json!([{"id":"base-text","type":"text","text":"baseline"}]),1,false) }
fn full_corpus(seed: u64) -> Vec<String> {
    let dir=tempfile::tempdir().unwrap();let budget=if seed&1==1 {8000.0}else{0.0};let temporal=seed&2!=0;
    let (h,project)=fixture(dir.path(),budget,temporal);let store=h.store.get().unwrap();let mut raw=vec![baseline()];
    for _ in 0..2 {transform::transform(store,&request(&raw,false),&context(&project,budget,temporal,1)).unwrap();}
    let mut out=Vec::new();
    for (pass,appended) in corpus(seed).into_iter().enumerate() {
        raw.extend(appended);let search=pass%3!=0;let req=request(&raw,search);
        let response=transform::transform(store,&req,&context(&project,budget,temporal,pass as i64+2)).unwrap();
        let mids=raw.iter().map(|m|m["info"]["id"].as_str().unwrap().to_owned()).collect();
        out.push(digest(&scalars(&response,&mids)));
    }
    out
}

#[test]
#[ignore = "explicit pre-extraction corpus generator"]
fn emit_pre_extraction_reference() {
    let path=std::env::var("MC_PROVIDER_PARITY_CAPTURE").expect("set a worktree-local fixture destination");
    let values=SEEDS.iter().map(|seed|(seed.to_string(),full_corpus(*seed))).collect::<BTreeMap<_,_>>();
    std::fs::write(path,serde_json::to_vec_pretty(&values).unwrap()).unwrap();
    println!("REFERENCE_CORPUS={}",serde_json::to_string(&values).unwrap());
    println!("captured {} seeds, {} passes",SEEDS.len(),SEEDS.len()*PASSES);
}

async fn host_message(h:&McHandler, raw:&Value, ordinal:u64, served:u64) -> Value {
    let mut result=raw.clone();
    let parts=raw["parts"].as_array().unwrap();
    let texts=parts.iter().filter(|p|p["type"]=="text").collect::<Vec<_>>();
    let mut subjects=Vec::new();
    if !texts.is_empty() {subjects.push((if raw["info"]["role"]=="user" {"pre_user"}else{"post_assistant"},None,texts.iter().map(|p|p["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>()));}
    for p in parts.iter().filter(|p|p["type"]=="tool") {subjects.push(("post_tool",Some(p),vec![p["state"]["output"].as_str().unwrap().to_owned()]));}
    for (kind,tool,blocks) in subjects {
        let mut call=json!({"session":"s","harness":"opencode","params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0},"lineage_id":"L","subject_mid":raw["info"]["id"],"subject_ordinal":ordinal,"message":raw,"hook":kind,"step_id":"parity","blocks":blocks,"served_through_ordinal":served});
        if let Some(p)=tool {call["subject_part"]=p["id"].clone();call["tool"]=p["tool"].clone();call["tool_call_id"]=p["callID"].clone();call["is_error"]=json!(false);}
        let answer:HookAnswer=decode(&super::host_tests::response(super::host_tests::dispatch(h,7,"transform.hook",call.clone()).await)).unwrap();
        let rendered=match answer {HookAnswer::Pass=>blocks.clone(),HookAnswer::Ops{ops}=>hooks::answer::apply_ops(&blocks,&ops).unwrap(),_=>panic!("text answer")};
        if let Some(p)=tool {let part=result["parts"].as_array_mut().unwrap().iter_mut().find(|r|r["id"]==p["id"]).unwrap();part["state"]["output"]=json!(rendered[0]);}
        else {let mut i=0;for p in result["parts"].as_array_mut().unwrap().iter_mut().filter(|p|p["type"]=="text") {p["text"]=json!(rendered[i]);i+=1;}}
    }
    result
}

#[tokio::test]
async fn randomized_and_adversarial_host_overlay_bytes_equal_full_engine_and_pre_extraction_corpus() {
    let frozen:BTreeMap<String,Vec<String>>=serde_json::from_str(include_str!("../../testdata/provider-overlay-reference.json")).unwrap();
    let mut comparisons=0;
    for seed in SEEDS {
        let host_dir=tempfile::tempdir().unwrap();let full_dir=tempfile::tempdir().unwrap();
        let budget=if seed&1==1 {8000.0}else{0.0};let temporal=seed&2!=0;
        let (host,host_project)=fixture(host_dir.path(),budget,temporal);let (full,full_project)=fixture(full_dir.path(),budget,temporal);
        let plan=json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
        super::host_tests::response(super::host_tests::dispatch(&host,7,"transform.declare",json!({"params":plan})).await);
        let mut raw=vec![baseline()];let mut served_native=raw.clone();
        for _ in 0..2 {transform::transform(full.store.get().unwrap(),&request(&raw,false),&context(&full_project,budget,temporal,1)).unwrap();transform::transform(host.store.get().unwrap(),&request(&raw,false),&context(&host_project,budget,temporal,1)).unwrap();}
        served_native[0]["parts"][0]["text"]=json!("§1§ baseline");
        for (pass,appended) in corpus(seed).into_iter().enumerate() {
            let prior=raw.len() as u64;let search=pass%3!=0;
            let mut binding=host.facade_binding(7).unwrap();binding.config.auto_search.enabled=search;host.bind_route(7,binding);
            let entries=appended.iter().enumerate().map(|(n,m)|json!({"mid":m["info"]["id"],"ordinal":prior+n as u64+1,"message":m})).collect::<Vec<_>>();
            let tail=entries.last().unwrap();
            super::host_tests::response(host.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"pass_id":format!("{seed}-{pass}"),"lineage_id":"L","appended":entries,"physical_tail":{"mid":tail["mid"],"ordinal":tail["ordinal"]}}})).await);
            for (n,m) in appended.iter().enumerate() {served_native.push(host_message(&host,m,prior+n as u64+1,prior).await);}
            raw.extend(appended);
            let expected=transform::transform(full.store.get().unwrap(),&request(&raw,search),&context(&full_project,budget,temporal,pass as i64+2)).unwrap();
            let mids=raw.iter().map(|m|m["info"]["id"].as_str().unwrap().to_owned()).collect::<BTreeSet<_>>();
            let expected=scalars(&expected,&mids);
            let served_entries=served_native.iter().enumerate().map(|(n,m)|compact::status::StatusMessage {mid:m["info"]["id"].as_str().unwrap().into(),ordinal:n as u64+1,message:m.clone()}).collect::<Vec<_>>();
            let decoded=super::super::codec_opencode::decode_messages(&served_entries).unwrap();
            for message in decoded.messages {
                let actual=message.ck.content.iter().enumerate().filter_map(|(i,b)|match &b.kind {mc_store::CkKind::Text{text}=>Some((i,text.clone())),mc_store::CkKind::ToolResult{output,..}=>match &output.kind {mc_store::CkOutputKind::Text{text}=>Some((i,text.clone())),_=>None},_=>None}).collect::<Vec<_>>();
                assert_eq!(actual,expected[&message.mid],"seed={seed:x} pass={pass} mid={}",message.mid);comparisons+=1;
            }
            assert_eq!(digest(&expected),frozen[&seed.to_string()][pass],"full engine changed after pure extraction: seed={seed:x} pass={pass}");
        }
    }
    println!("overlay parity: {} seeds {:?}, {} passes, {comparisons} per-message byte comparisons",SEEDS.len(),SEEDS,SEEDS.len()*PASSES);
}
