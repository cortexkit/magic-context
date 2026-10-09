//! Strict-prefix receipts are created from the production transform's served
//! request before each mock response, not inferred from the later replay.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest, TransformResponse};
use mc_store::McStore;
use serde_json::{json, Value};

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:signed-prefix-audit", note_project_path: "git:signed-prefix-audit",
        project_directory: "/nonexistent-docs", history_budget_tokens: 60000.0,
        memory_budget_tokens: 8000.0, user_profile_budget_tokens: 4000.0,
        memory_enabled: false, inject_docs: false, temporal_awareness: false, now_ms: 1000,
        execute_threshold_percentage: 65.0, protected_tokens_floor: 0,
        protected_tokens_provenance: "config", compaction_enabled: true,
        smart_drops: false, protected_tools: Default::default(), cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default, cache_ttl_policy: None,
        model_key: None, observed_last_response_at_ms: None, guidance_date: None,
        historian_active: false, wrapup_active: false, caveman_english_word_rules: true,
    }
}

fn message(id: &str, ordinal: u64, role: &str, kinds: Vec<Value>) -> Value {
    json!({"mid":id,"ordinal":ordinal,"ck":{"role":role,
        "content":kinds.into_iter().map(|kind| json!({"kind":kind})).collect::<Vec<_>>(),
        "meta":{"harness_id":id}}})
}
fn request(profile: &str, subagent: bool) -> TransformRequest {
    serde_json::from_value(json!({"serializer_profile":profile,"session_id":"prefix-audit",
        "render_config":"stable","provider_id":"anthropic","model_key":"anthropic/claude-opus-5-5",
        "is_subagent":subagent,"tool_present":true,"todo_tool_present":true,
        "auto_search_enabled":false,"clear_reasoning_age":1000,"keep_reasoning_tokens_effective":1000000,
        "usage":{"current_total_input_tokens":20000,"context_limit_tokens":100000},
        "messages":[message("prompt",1,"user",vec![json!({"type":"text","text":"Inspect the parser, repair it and continue using tools until done."})])]
    })).unwrap()
}
fn projection(response: &TransformResponse) -> Vec<Value> {
    serde_json::to_value(response.messages()).unwrap().as_array().unwrap().iter().flat_map(|m| {
        m["content"].as_array().unwrap().iter().filter_map(|b| {
            let kind = &b["kind"];
            if kind["type"] == "text" && kind["text"] == "" { None }
            else { Some(json!([m["role"],kind])) }
        }).collect::<Vec<_>>()
    }).collect()
}

#[derive(Default)]
struct StrictMock { receipts: Vec<(Value, Vec<Value>, u64)>, turn: u64 }
impl StrictMock {
    fn emit(&mut self, request: Vec<Value>) -> Value {
        assert_eq!(self.check(&request), None);
        let thinking = json!({"type":"reasoning","text":format!("Inspect step {}",self.receipts.len()+1),"signature":format!("sig-{}",self.receipts.len()+1)});
        self.receipts.push((thinking.clone(),request,self.turn));
        thinking
    }
    fn check(&self, request: &[Value]) -> Option<&'static str> {
        let signatures: Vec<_> = request.iter().filter(|v| v[1]["type"] == "reasoning").map(|v| v[1]["signature"].clone()).collect();
        let kept: Vec<_> = self.receipts.iter().enumerate().filter(|(_,r)| signatures.contains(&r.0["signature"])).map(|(i,_)| i).collect();
        if !kept.is_empty() && kept.last().unwrap()-kept[0]+1 != kept.len() { return Some("middle thinking removal"); }
        if self.receipts.iter().any(|r| r.2 == self.turn && !signatures.contains(&r.0["signature"])) { return Some("latest turn thinking modified"); }
        let normalize = |prefix: &[Value]| prefix.iter().filter(|v| v[1]["type"] != "reasoning" || signatures.contains(&v[1]["signature"])).cloned().collect::<Vec<_>>();
        for (i, block) in request.iter().enumerate().filter(|(_,v)| v[1]["type"] == "reasoning") {
            let Some(receipt) = self.receipts.iter().find(|r| r.0["signature"] == block[1]["signature"]) else { return Some("unknown signature"); };
            if receipt.0 != block[1] { return Some("thinking bytes modified"); }
            if normalize(&request[..i]) != normalize(&receipt.1) { return Some("bound to a different conversation"); }
        }
        None
    }
}

fn run_case(profile: &str, subagent: bool, lane: &str) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor { module_id:"prefix-audit".into(), storage_namespace:"mc_cache".into(), isolation:Isolation::Module, backend:StorageBackend::Sqlite {path:dir.path().join("store.db").to_string_lossy().into()} }).unwrap();
    let mut req = request(profile,subagent);
    let ctx = context();
    transform(&store,&req,&ctx).unwrap();
    // Append unsigned history only after the cold baseline so a first-render
    // cleanup cannot remove the candidate before any signature binds to it.
    req.messages.push(serde_json::from_value(message("unsigned",2,"assistant",vec![json!({"type":"text","text":if lane=="sentinel" {"[dropped §999§]"} else {"Inspecting files."}})])).unwrap());
    if lane == "todo" { store.set_todo_state(&req.session_id,"[{\"content\":\"Inspect parser\",\"status\":\"in_progress\",\"priority\":\"high\"}]","unsigned","initial").unwrap(); store.arm_soft_refresh(&req.session_id).unwrap(); }
    let mut served = transform(&store,&req,&ctx).unwrap();
    let mut oracle = StrictMock::default();
    for n in 1..=6 {
        let thinking = oracle.emit(projection(&served));
        let id = format!("step-{n}"); let call = format!("call-{n}");
        req.messages.push(serde_json::from_value(message(&id,n*2+1,"assistant",vec![thinking,json!({"type":"tool_call","id":call,"name":"read","input":{"path":format!("parser-{n}.ts")},"provider_executed":false})])).unwrap());
        req.messages.push(serde_json::from_value(message(&format!("result-{n}"),n*2+2,"tool",vec![json!({"type":"tool_result","id":call,"tool_name":"read","output":{"kind":{"type":"text","text":"export const parsed = true;\n".repeat(300)}},"provider_executed":false})])).unwrap());
        served=transform(&store,&req,&ctx).unwrap();
        assert_eq!(oracle.check(&projection(&served)),None,"bootstrap {profile} {subagent} step {n}");
    }
    if lane=="todo" { store.set_todo_state(&req.session_id,"[{\"content\":\"Repair parser\",\"status\":\"pending\",\"priority\":\"high\"}]","step-6","changed").unwrap(); }
    store.arm_soft_refresh(&req.session_id).unwrap();
    req.usage=serde_json::from_value(json!({"current_total_input_tokens":85000,"context_limit_tokens":100000})).unwrap();
    let busted=transform(&store,&req,&ctx).unwrap();
    let rejection=oracle.check(&projection(&busted));
    println!("AUDIT {profile} subagent={subagent} {lane}: {rejection:?}");
    let expected=if std::env::var("MC_AUDIT_EXPECT_VALID").as_deref()==Ok("1") {None} else {Some("bound to a different conversation")};
    assert_eq!(rejection,expected);
}

#[test] fn opencode_primary_sentinel() { run_case("opencode-aisdk",false,"sentinel"); }
#[test] fn opencode_subagent_sentinel() { run_case("opencode-aisdk",true,"sentinel"); }
#[test] fn claude_code_primary_sentinel() { run_case("claude-code-anthropic",false,"sentinel"); }
#[test] fn claude_code_subagent_sentinel() { run_case("claude-code-anthropic",true,"sentinel"); }
#[test] fn opencode_primary_todo() { run_case("opencode-aisdk",false,"todo"); }
#[test] fn claude_code_primary_todo() { run_case("claude-code-anthropic",false,"todo"); }
