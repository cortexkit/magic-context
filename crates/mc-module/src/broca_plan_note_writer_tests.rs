use super::*;
use cortexkit_role_compaction::part::ToolStatus;
use cortexkit_role_compaction::wire;
use cortexkit_role_llm_runner::{run::RunStatus, wire::read_reply};
use serde::de::DeserializeOwned;

const SAMPLES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/testdata/broca-plan-note-writer-1128"
);
const SIDES: [&str; 2] = ["before", "after"];
const SESSIONS: [&str; 3] = ["no-call", "folded-counts", "tool-call"];

fn pairs() -> impl Iterator<Item = String> {
    SIDES.into_iter().flat_map(|side| {
        SESSIONS
            .into_iter()
            .map(move |session| format!("{side}/{session}"))
    })
}

fn bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{SAMPLES}/{name}")).unwrap_or_else(|err| panic!("{name}: {err}"))
}

fn bare<T: DeserializeOwned>(dir: &str, file: &str) -> T {
    let name = format!("{dir}/{file}.json");
    serde_json::from_slice(&bytes(&name)).unwrap_or_else(|err| panic!("{name}: {err}"))
}

fn runner_reply<T: DeserializeOwned>(dir: &str, file: &str) -> T {
    let name = format!("{dir}/{file}.json");
    read_reply(&bytes(&name)).unwrap_or_else(|err| panic!("{name}: {err:?}"))
}

fn entries(dir: &str, detail: &str) -> ReadPage {
    let name = format!("{dir}/compaction.session.entries.{detail}.json");
    crate::transport::decode_session_entries(dir, &bytes(&name))
        .unwrap_or_else(|err| panic!("{name}: {err:?}"))
}

fn outbound(dir: &str, file: &str) -> (Vec<u8>, Value) {
    let name = format!("{dir}/outbound.compaction.{file}.json");
    let (method, _) = file.rsplit_once('.').unwrap();
    // Broca captured the compaction params before transport. Add only the
    // method-and-params envelope the module receives.
    let mut body = format!(r#"{{"method":"compaction.{method}","params":"#).into_bytes();
    body.extend(bytes(&name));
    body.push(b'}');
    let (decoded_method, params) = wire::decode(&body).unwrap();
    assert_eq!(decoded_method, format!("compaction.{method}"));
    (body, params)
}

fn setup(dir: &str) -> SetupRequest {
    let (_, params) = outbound(dir, "setup.00");
    wire::params(params).unwrap_or_else(|err| panic!("{dir}/setup.00: {err:?}"))
}

fn notices(dir: &str) -> impl Iterator<Item = NoticeRequest> + '_ {
    let last = if dir.ends_with("/tool-call") { 7 } else { 5 };
    (1..=last).map(move |seq| {
        let (body, params) = outbound(dir, &format!("notice.{seq:02}"));
        let notice = crate::transport::decode_entry_notice(dir, &body, params)
            .unwrap_or_else(|err| panic!("{dir}/notice.{seq:02}: {err:?}"));
        assert_eq!(notice.seq, seq);
        notice
    })
}

#[test]
fn fixture_hashes_match_broca() {
    use sha2::{Digest, Sha256};
    let manifest = std::fs::read_to_string(format!("{SAMPLES}/SHA256SUMS")).unwrap();
    assert_eq!(manifest.lines().count(), 106);
    for line in manifest.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(bytes(name))), hash, "{name}");
    }
}

#[test]
fn session_entries_full_and_compact_decode_and_index() {
    for dir in pairs() {
        for detail in ["full", "compact"] {
            let page = entries(&dir, detail);
            let mut index = Index::default();
            assert_eq!(
                index.extend_counted(page.entries, page.token_family.as_deref()),
                Extend::Continued,
                "{dir}/{detail}"
            );
            assert!(index.ends_at(page.head.newest.as_ref()), "{dir}/{detail}");
            let tools: Vec<_> = index
                .entries()
                .iter()
                .flat_map(|entry| &entry.parts)
                .filter_map(|part| match &part.body {
                    PartBody::Text { .. } => None,
                    PartBody::Tool(tool) => Some((part, tool)),
                    other => panic!("{dir}/{detail}: unexpected part {other:?}"),
                })
                .collect();
            if !dir.ends_with("/tool-call") {
                assert_eq!(index.entries().len(), 4, "{dir}/{detail}");
                assert!(tools.is_empty(), "{dir}/{detail}");
                continue;
            }
            assert_eq!(index.entries().len(), 6, "{dir}/{detail}");
            let [(part, tool)] = tools.as_slice() else {
                panic!("{dir}/{detail}: expected one tool part");
            };
            let after = dir.starts_with("after/");
            let (status, count, size) = if after {
                (ToolStatus::Completed, 6, 6)
            } else {
                (ToolStatus::Error, 23, 54)
            };
            assert_eq!(tool.name, "lookup");
            assert_eq!(tool.status, status, "{dir}/{detail}");
            assert_eq!(tool.output_bytes, Some(size), "{dir}/{detail}");
            assert_eq!(
                crate::tokens::tool_output(part, tool),
                count,
                "{dir}/{detail}"
            );
            assert_eq!(tool.output.is_some(), detail == "full", "{dir}/{detail}");
            assert_eq!(crate::tokens::part(part), 5 + count, "{dir}/{detail}");
            let context = lanes::Context {
                index: &index,
                edited: &lanes::Edited::default(),
                protected_tools: &Default::default(),
                keep_first_message: false,
                signed_floor: None,
            };
            assert!(
                lanes::retried_failures(&context, None).is_empty(),
                "{dir}/{detail}"
            );
        }
    }
}

#[test]
fn session_apply_view_decodes() {
    for dir in pairs() {
        let answer: ApplyViewAnswer = bare(&dir, "compaction.session.apply_view");
        assert!(matches!(answer, ApplyViewAnswer::Accepted), "{dir}");
    }
}

#[test]
fn session_applied_view_decodes() {
    for dir in pairs() {
        let before: AppliedViewAnswer = bare(&dir, "compaction.session.applied_view.before");
        let after: AppliedViewAnswer = bare(&dir, "compaction.session.applied_view.after");
        assert!(before.view.is_none(), "{dir}");
        assert_eq!(after.applied_by.as_deref(), Some("ck-mc"), "{dir}");
        let view = after.view.unwrap();
        assert_eq!(view.version, 1, "{dir}");
        assert!(view.edits.is_empty(), "{dir}");
    }
}

#[test]
fn compaction_setup_decodes() {
    for dir in pairs() {
        let setup = setup(&dir);
        assert_eq!(setup.newest.unwrap().ordinal, 1, "{dir}");
        assert_eq!(setup.rules.signed_parts, SignedParts::Bound, "{dir}");
    }
}

#[test]
fn compaction_notices_decode() {
    for dir in pairs() {
        for notice in notices(&dir) {
            assert_eq!(notice.token_family.as_deref(), Some("claude-v5/1"), "{dir}");
            assert_eq!(notice.conditions.tools_tokens.unwrap().count, 31, "{dir}");
            assert!(!notice.entries.is_empty(), "{dir}");
        }
    }
}

#[test]
fn run_result_decodes() {
    for dir in pairs() {
        let reply: RunResult = runner_reply(&dir, "run.result");
        assert_eq!(reply.state, "completed", "{dir}");
        assert!(!reply.run_id.is_empty(), "{dir}");
    }
}

#[test]
fn run_status_decodes() {
    for dir in pairs() {
        let reply: RunStatus = runner_reply(&dir, "run.status");
        assert_eq!(reply.state, "completed", "{dir}");
    }
}

#[test]
fn session_send_decodes() {
    for dir in pairs() {
        for phase in ["initial", "delivery", "view"] {
            let reply: SendReply = runner_reply(&dir, &format!("session.send.{phase}"));
            assert!(!reply.state.is_empty(), "{dir}/{phase}");
        }
    }
}

#[tokio::test]
async fn role_describe_decodes_and_declares_notice_keep() {
    for dir in pairs() {
        let reply: Value = runner_reply(&dir, "role.describe");
        let capabilities = crate::runner_capabilities::RunnerCapabilities::default();
        assert!(
            capabilities
                .notice_keep("broca", 1, async { Ok(reply) })
                .await,
            "{dir}"
        );
    }
}

async fn check_accounting(sample: &str, with_notes: bool) {
    for side in SIDES {
        let dir = format!("{side}/{sample}");
        let (_, client, route, _, mut settings) = fixture();
        settings.memory_enabled = false;
        let setup = setup(&dir);
        // Broca's capture rig uses its own preset name. Seed a compacting head
        // so the captured notices reach the same pass a head would run.
        let features = crate::preset::features("head").unwrap();
        let mut session = Session::new(&route, &setup, features, None);
        let mut page = entries(&dir, "full");
        page.entries.truncate(1);
        assert_eq!(
            session
                .index
                .extend_counted(page.entries, page.token_family.as_deref()),
            Extend::Continued
        );
        assert!(session.index.ends_at(setup.newest.as_ref()));
        let first = &session.index.entries()[0];
        let key = (first.mid.clone(), first.parts[0].id.clone());
        session.queued.insert(key.clone());
        *client.applied.lock().unwrap() = Some(bare(&dir, "compaction.session.applied_view.after"));

        let note_count = if side == "before" { 9 } else { 33 };
        let mut previous_notes = None;
        for notice in notices(&dir) {
            let seq = notice.seq;
            let summary = session.notice(&client, &settings, notice).await;
            assert_eq!(session.seq, seq, "{dir}");
            assert!(session.index_ready, "{dir}/{seq}");
            assert_eq!(session.index.entries().len() as u64, seq + 1, "{dir}/{seq}");
            assert_eq!(session.notes.measured, previous_notes, "{dir}/{seq}");
            let pending = with_notes.then(|| {
                cortexkit_role_compaction::tokens::SurfaceTokens::new(
                    if seq == 1 { 0 } else { note_count },
                    seq == 1,
                )
            });
            assert_eq!(session.notes.pending, pending, "{dir}/{seq}");
            previous_notes = pending;
            let surface = |tokens: Option<cortexkit_role_compaction::tokens::SurfaceTokens>| {
                tokens.unwrap().count
            };
            let system = surface(session.surface_tokens.0);
            let tools = surface(session.surface_tokens.1);
            assert_eq!(
                system,
                if with_notes || seq == 1 {
                    6
                } else {
                    6 + note_count
                }
            );
            assert_eq!(tools, 31);
            let declared_fixed = system + tools + pending.map_or(0, |tokens| tokens.count);
            assert_eq!(declared_fixed, if seq == 1 { 37 } else { 37 + note_count });
            assert_eq!(pass::usage(&session.pressure()), None, "{dir}/{seq}");
            // Inexact estimates do not adjust the prediction if a measured
            // fixed part is available. These frames carry no such baseline.
            assert_eq!(session.notes.fixed_part(100.0), 100.0, "{dir}/{seq}");
            assert!(summary.is_none(), "{dir}/{seq}");
            assert!(!session.fold_due && !session.head_stale, "{dir}/{seq}");
            assert!(session.cut_ordinal().is_none(), "{dir}/{seq}");
            assert!(session.queued.contains(&key), "{dir}/{seq}");
            // The capture itself installs a no-edit view before notice 4;
            // adopting it is not a rebuild or publication by the module.
            assert_eq!(session.version, u64::from(seq >= 4), "{dir}/{seq}");
            assert!(client.offered.lock().unwrap().is_empty(), "{dir}/{seq}");
        }
    }
}

#[tokio::test]
async fn accounting_with_notes_extension() {
    check_accounting("no-call", true).await;
}

#[tokio::test]
async fn accounting_with_notes_folded_into_system() {
    check_accounting("folded-counts", false).await;
}
