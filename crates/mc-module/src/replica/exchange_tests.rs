//! Two (or three) stores exchanging messages through one in-memory hub, as
//! a user's computers do through theirs.

use std::sync::Arc;

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};
use super::wire;

fn contents(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT content FROM memories ORDER BY content")
}

fn outbox(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT kind || ':' || local_id || ':' || state FROM replica_outbox ORDER BY id")
}

fn writers(hub: &InMemoryHub) -> Vec<String> {
    hub.messages()
        .iter()
        .map(|message| {
            let id = message.message_id.clone().unwrap_or_default();
            id.split('.').next().unwrap_or_default().to_owned()
        })
        .collect()
}

#[tokio::test]
async fn a_memory_reaches_the_other_computer_and_its_arrival_is_never_sent_again() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let id = memory(&a, "pj-a", "The parser rejects empty input.");
    a.sync().await;
    b.sync().await;
    assert_eq!(contents(&b), ["The parser rejects empty input."]);
    let global = wire::global_id(&a.store_id(), "memory", id);
    assert_eq!(
        b.value::<String>("SELECT global_id FROM memories"),
        global,
        "the arrival keeps the id it was first sent under"
    );
    // The arrival wrote no outbox row, and sending finds nothing to send.
    assert!(outbox(&b).is_empty());
    assert_eq!(b.replica.publish().await.unwrap().sent, 0);
    // A's own message came back: it only moved A's position and settled
    // the row that waited for it.
    a.follow_all().await;
    assert!(outbox(&a).is_empty());
    assert_eq!(a.replica.position().unwrap(), 1);
    assert_eq!(writers(&hub), [a.store_id()]);
    assert_eq!(hub.acked(), [1, 1]);
}

#[tokio::test]
async fn an_arrival_sends_the_change_notices_of_a_local_write_and_no_epoch_bump() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "The parser rejects empty input.");
    a.sync().await;
    b.replica.join().await.unwrap();
    let wakes = Arc::new(crate::memory_changed::MemoryWakes::default());
    b.db.wake_on_memory_changes(Arc::clone(&wakes));
    let before =
        b.db.with_connection(|conn| crate::memory_changed::revision(conn))
            .unwrap();
    a.execute("UPDATE memories SET content = 'The parser rejects blank input.'");
    a.publish_all().await;
    b.follow_all().await;
    let woken: Vec<(String, Option<String>)> = wakes
        .take()
        .into_iter()
        .map(|owner| (owner.level.to_owned(), owner.id))
        .collect();
    assert_eq!(woken, [("project".to_owned(), Some("pj-a".to_owned()))]);
    let after =
        b.db.with_connection(|conn| crate::memory_changed::revision(conn))
            .unwrap();
    assert!(after > before, "the wake carries a newer revision");
    let epochs: i64 = b.value("SELECT COUNT(*) FROM project_state WHERE project_memory_epoch <> 0");
    assert_eq!(epochs, 0);
}

/// Both computers change one memory before either hears of the other's
/// change. Both send under the same revision, and each writer's message has
/// an id of its own, so the hub keeps both: of equal revisions the later
/// message in the stream decides, so both end with B's change, and A's
/// replaced text is in A's history.
#[tokio::test]
async fn concurrent_edits_under_one_revision_converge_on_the_later_message_with_the_replaced_text_in_history(
) {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    b.execute("UPDATE memories SET content = 'Releases need three reviewers.'");
    a.publish_all().await;
    b.publish_all().await;
    assert_eq!(hub.messages().len(), 3, "the hub keeps both changes");
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(contents(&a), ["Releases need three reviewers."]);
    assert_eq!(contents(&b), ["Releases need three reviewers."]);
    assert_eq!(
        a.texts("SELECT previous_text FROM memory_history"),
        ["Releases need two reviewers."]
    );
    assert!(outbox(&a).is_empty() && outbox(&b).is_empty());
}

/// The same race when the second change carries a newer revision: the
/// later message in the stream wins on both computers.
#[tokio::test]
async fn concurrent_edits_converge_on_the_later_message_in_the_stream() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    // B's writer raises the revision past A's.
    b.execute(
        "UPDATE memories SET revision = revision + 2;
         UPDATE memories SET content = 'Releases need three reviewers.';",
    );
    a.publish_all().await;
    b.publish_all().await;
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(contents(&a), ["Releases need three reviewers."]);
    assert_eq!(contents(&b), ["Releases need three reviewers."]);
    assert_eq!(
        a.texts("SELECT previous_text FROM memory_history"),
        ["Releases need two reviewers."]
    );
    // B's arrival of A's change was skipped: B's own change was later.
    assert!(b
        .texts("SELECT previous_text FROM memory_history")
        .is_empty());
    // Both keep converging after more changes.
    a.execute("UPDATE memories SET importance = 90");
    a.sync().await;
    b.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT importance FROM memories"), 90);
}

/// Each row's live state and the global id of the row that supersedes it,
/// by global id: what every computer must agree on.
fn rows(computer: &Computer) -> Vec<String> {
    computer.texts(
        "SELECT m.global_id || ' ' || COALESCE(m.status, 'active') || ' '
                || COALESCE(s.global_id, '-') || ' ' || m.content
           FROM memories m LEFT JOIN memories s ON s.id = m.superseded_by_memory_id
          ORDER BY m.global_id",
    )
}

/// The same fact written on two computers is two rows, one global id each.
/// The one with the lower global id stays live on every computer and the
/// other is archived, superseded by it, whatever order they arrived in.
/// The archive is each computer's own: it is never sent, and a change to
/// either row decides again.
#[tokio::test]
async fn the_same_fact_written_on_two_computers_leaves_one_live_row_everywhere() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need two reviewers.");
    memory(&b, "pj-a", "Releases need two reviewers.");
    a.sync().await;
    b.sync().await;
    a.follow_all().await;
    assert_eq!(hub.messages().len(), 2, "each computer's create was sent");
    assert_eq!(rows(&a), rows(&b));
    assert_eq!(a.live(), ["Releases need two reviewers."]);
    assert_eq!(b.live(), ["Releases need two reviewers."]);
    let (low, high) = {
        let mut ids = [
            wire::global_id(&a.store_id(), "memory", 1),
            wire::global_id(&b.store_id(), "memory", 1),
        ];
        ids.sort();
        (ids[0].clone(), ids[1].clone())
    };
    assert_eq!(
        rows(&a),
        [
            format!("{low} active - Releases need two reviewers."),
            format!("{high} archived {low} Releases need two reviewers.")
        ]
    );
    // The archive is not sent.
    assert!(outbox(&a).is_empty() && outbox(&b).is_empty());
    // The surviving row's text changes: the other holds the fact alone and
    // is live again on both.
    a.execute(&format!(
        "UPDATE memories SET content = 'Releases need three reviewers.',
                normalized_hash = '{}' WHERE global_id = '{low}'",
        crate::memory_writes::normalized_hash("Releases need three reviewers.")
    ));
    a.sync().await;
    b.follow_all().await;
    assert_eq!(rows(&a), rows(&b));
    assert_eq!(
        a.live(),
        [
            "Releases need three reviewers.",
            "Releases need two reviewers."
        ]
    );
    // A computer joining late ends with the same rows.
    let c = Computer::new(&hub, 3);
    c.sync().await;
    assert_eq!(rows(&c), rows(&a));
}

#[tokio::test]
async fn a_link_to_a_memory_not_seen_yet_waits_and_resolves_when_it_arrives() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.replica.join().await.unwrap();
    // The survivor is written first, so it is sent before its source.
    let survivor = memory(&a, "pj-a", "Releases need two reviewers and a tag.");
    let source = memory(&a, "pj-a", "Releases need two reviewers.");
    a.execute(&format!(
        "UPDATE memories SET merged_from = '[{source}]' WHERE id = {survivor};
         UPDATE memories SET status = 'archived', superseded_by_memory_id = {survivor} WHERE id = {source};
         INSERT INTO memory_successor_links (source_id, successor_id, decision_key)
             VALUES ({source}, {survivor}, 'k1');"
    ));
    a.publish_all().await;
    let messages = hub.messages();
    assert!(messages[0]
        .message_id
        .as_deref()
        .unwrap()
        .starts_with(&wire::global_id(&a.store_id(), "memory", survivor)));
    // B reads the survivor alone first: its links wait.
    let only_first = InMemoryHub::new();
    only_first.inject(
        &messages[0].subject,
        messages[0].message_id.as_deref(),
        messages[0].payload.clone(),
    );
    let early = Computer::new(&only_first, 3);
    early.follow_all().await;
    assert_eq!(
        early.value::<i64>("SELECT COUNT(*) FROM replica_pending_links"),
        2,
        "merged_from and the successor link wait for the source"
    );
    // On the full stream the source arrives and the links are made.
    b.sync().await;
    let (b_survivor, b_source): (i64, i64) = (
        b.value("SELECT id FROM memories WHERE content LIKE '%tag.'"),
        b.value("SELECT id FROM memories WHERE content = 'Releases need two reviewers.'"),
    );
    assert_eq!(
        b.value::<String>(&format!(
            "SELECT merged_from FROM memories WHERE id = {b_survivor}"
        )),
        format!("[{b_source}]")
    );
    assert_eq!(
        b.value::<i64>(&format!(
            "SELECT superseded_by_memory_id FROM memories WHERE id = {b_source}"
        )),
        b_survivor
    );
    assert_eq!(
        b.value::<String>("SELECT source_id || '>' || successor_id || ':' || decision_key FROM memory_successor_links"),
        format!("{b_source}>{b_survivor}:k1")
    );
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM replica_pending_links"),
        0
    );
}

#[tokio::test]
async fn a_bad_message_is_recorded_and_skipped_and_the_next_one_applies() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.replica.join().await.unwrap();
    hub.inject(
        "ck.fleet.memory.project.pj-a",
        Some("x@1"),
        b"not json".to_vec(),
    );
    memory(&a, "pj-a", "The first good memory.");
    a.publish_all().await;
    // A message whose ciphertext was changed on the way doesn't open.
    let mut tampered = hub.messages()[1].clone();
    let mut envelope: wire::Envelope = serde_json::from_slice(&tampered.payload).unwrap();
    envelope.ciphertext = wire::encode(b"0123456789abcdef0123");
    tampered.payload = envelope.to_bytes();
    hub.inject(&tampered.subject, Some("y@1"), tampered.payload);
    memory(&a, "pj-a", "The second good memory.");
    a.publish_all().await;
    b.sync().await;
    assert_eq!(
        contents(&b),
        ["The first good memory.", "The second good memory."]
    );
    assert_eq!(
        b.texts("SELECT stream_seq || ':' || reason FROM replica_rejects ORDER BY stream_seq"),
        [
            "1:not a sealed envelope",
            "3:not opened: fleet_epoch_open_failed under epoch 1, which this computer's vault holds"
        ]
    );
    assert_eq!(b.replica.position().unwrap(), 4);
}

/// B's own copy of a fact A sent first is sent too, and archived on every
/// computer unless its global id is the lower one, so each computer ends
/// with one live row per fact and the same rows.
#[tokio::test]
async fn a_joining_computer_applies_the_history_first_and_converges_with_one_live_row_per_fact() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Shared fact.");
    memory(&a, "pj-a", "Only on A.");
    a.sync().await;
    // B had memories before it ever followed the stream, one of them the
    // same fact, one archived; none of them was queued by a writer.
    memory(&b, "pj-a", "Shared fact.");
    let archived = memory(&b, "pj-a", "Only on B, archived.");
    b.execute(&format!(
        "UPDATE memories SET status = 'archived' WHERE id = {archived};
         DELETE FROM replica_outbox;"
    ));
    b.sync().await;
    a.follow_all().await;
    b.follow_all().await;
    let expected = [
        "Only on A.",
        "Only on B, archived.",
        "Shared fact.",
        "Shared fact.",
    ];
    assert_eq!(contents(&a), expected);
    assert_eq!(contents(&b), expected);
    assert_eq!(a.live(), ["Only on A.", "Shared fact."]);
    assert_eq!(rows(&a), rows(&b));
    assert_eq!(
        a.value::<String>("SELECT status FROM memories WHERE content = 'Only on B, archived.'"),
        "archived"
    );
    assert_eq!(hub.messages().len(), 4);
    assert!(b.replica.joined_at().unwrap().is_some());
}

#[tokio::test]
async fn nothing_is_sent_before_the_computer_joined() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Waits for the join.");
    assert_eq!(a.replica.publish().await.unwrap().sent, 0);
    assert!(hub.messages().is_empty());
    a.sync().await;
    assert_eq!(hub.messages().len(), 1);
}

#[tokio::test]
async fn a_delete_for_good_reaches_every_computer_and_a_late_snapshot_never_brings_it_back() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let id = memory(&a, "pj-a", "A secret the person deletes.");
    a.sync().await;
    b.sync().await;
    // B changes it, and its text goes to A's history on arrival.
    b.execute("UPDATE memories SET content = 'A secret, edited.'");
    b.sync().await;
    a.follow_all().await;
    assert_eq!(a.value::<i64>("SELECT COUNT(*) FROM memory_history"), 1);
    let create = hub.messages()[0].clone();
    a.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, id).unwrap();
        tx.commit().unwrap();
    });
    a.sync().await;
    b.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memories"), 0);
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memory_history"), 0);
    assert_eq!(a.value::<i64>("SELECT COUNT(*) FROM memory_history"), 0);
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM replica_ids WHERE deleted_at IS NOT NULL"),
        1
    );
    // A late snapshot from a computer that hadn't seen the delete is a good
    // message for a row that is gone: skipped, not recorded as a bad one.
    hub.inject(&create.subject, Some("late@9"), create.payload.clone());
    b.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memories"), 0);
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM replica_rejects"), 0);
    assert_eq!(b.replica.position().unwrap(), hub.messages().len() as u64);
    // A computer joining later replays the create, the edit and the
    // tombstone, and ends without the row.
    let c = Computer::new(&hub, 3);
    c.sync().await;
    assert_eq!(c.value::<i64>("SELECT COUNT(*) FROM memories"), 0);
    // The tombstone carries no snapshot and no text.
    let tombstone = hub.messages()[2].clone();
    let envelope: wire::Envelope = serde_json::from_slice(&tombstone.payload).unwrap();
    let opened = super::test_support::TestSealer::new(super::test_support::KEY, 1).open_one(
        &super::seal::OpenInput {
            epoch: envelope.epoch,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
            aad: wire::aad(&envelope.global_id, envelope.revision, &tombstone.subject),
        },
    );
    let super::seal::Opened::Plaintext(bytes) = opened else {
        panic!("the tombstone opens");
    };
    let body: wire::Body = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        (body.change.as_str(), body.snapshot.is_none()),
        ("delete", true)
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
}

#[tokio::test]
async fn an_unconfirmed_publish_is_sent_again_under_the_same_id_and_stored_once() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    a.replica.join().await.unwrap();
    memory(&a, "pj-a", "Stored once.");
    hub.lose_next_acks(1);
    let first = a.replica.publish().await;
    assert!(first.is_err(), "the only publish was unconfirmed");
    assert_eq!(outbox(&a), ["memory:1:sending"]);
    let second = a.replica.publish().await.unwrap();
    assert_eq!(second.sent, 1);
    assert_eq!(hub.messages().len(), 1);
    assert_eq!(hub.publish_calls(), 2);
    assert_eq!(outbox(&a), ["memory:1:published"]);
    // A hub that refuses leaves the row to send later.
    memory(&a, "pj-a", "Sent after an outage.");
    hub.refuse_next(1);
    assert!(a.replica.publish().await.is_err());
    a.publish_all().await;
    assert_eq!(hub.messages().len(), 2);
}

#[tokio::test]
async fn several_changes_before_a_send_go_out_as_one_message_with_the_newest_state() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Version one.");
    a.sync().await;
    a.execute(
        "UPDATE memories SET content = 'Version two.';
         UPDATE memories SET content = 'Version three.';
         UPDATE memories SET importance = 61;",
    );
    assert_eq!(outbox(&a), ["memory:1:pending"]);
    a.publish_all().await;
    assert_eq!(hub.messages().len(), 2);
    assert_eq!(
        hub.messages()[1].message_id.as_deref(),
        Some(
            format!(
                "{}@2/{}",
                wire::global_id(&a.store_id(), "memory", 1),
                a.store_id()
            )
            .as_str()
        )
    );
    b.sync().await;
    assert_eq!(contents(&b), ["Version three."]);
    assert_eq!(b.value::<i64>("SELECT importance FROM memories"), 61);
}

#[tokio::test]
async fn a_sealed_message_over_sixty_kib_stays_in_the_outbox_as_too_large() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    a.replica.join().await.unwrap();
    let big = "x".repeat(70 * 1024);
    memory(&a, "pj-a", &big);
    let report = a.replica.publish().await.unwrap();
    assert_eq!(report.too_large, 1);
    assert!(hub.messages().is_empty());
    assert_eq!(outbox(&a), ["memory:1:too_large"]);
    assert_eq!(a.replica.publish().await.unwrap(), Default::default());
    // A change makes it a candidate again.
    a.execute("UPDATE memories SET content = 'Short now.'");
    a.publish_all().await;
    assert_eq!(hub.messages().len(), 1);
}

#[tokio::test]
async fn an_owner_outside_the_subject_lexicon_waits_until_the_owner_changes() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    a.replica.join().await.unwrap();
    memory(&a, "/Users/someone/project", "A 0.49 path owner.");
    let report = a.replica.publish().await.unwrap();
    assert_eq!(report.unaddressable, 1);
    assert_eq!(outbox(&a), ["memory:1:unaddressable"]);
    a.execute("UPDATE memories SET owner_id = 'pj-moved'");
    a.publish_all().await;
    assert_eq!(
        hub.messages()[0].subject,
        "ck.fleet.memory.project.pj-moved"
    );
}

#[tokio::test]
async fn a_memory_an_observation_and_a_primer_with_one_local_id_all_arrive() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.execute(
        "INSERT INTO memory_observations (content, session_id, created_at) VALUES ('Likes tea.', 's', 1);
         INSERT INTO primers (project_path, question, answer, created_at, updated_at)
             VALUES ('pj-a', 'How is it built?', 'With cargo.', 1, 1);",
    );
    let id = memory(&a, "pj-a", "Builds use cargo.");
    assert_eq!(
        (
            id,
            a.value::<i64>("SELECT id FROM memory_observations"),
            a.value::<i64>("SELECT id FROM primers")
        ),
        (1, 1, 1)
    );
    a.sync().await;
    b.sync().await;
    let ids: Vec<String> = hub
        .messages()
        .iter()
        .map(|message| message.message_id.clone().unwrap())
        .collect();
    let store = a.store_id();
    assert_eq!(
        ids,
        [
            format!("{store}.o1@1/{store}"),
            format!("{store}.p1@1/{store}"),
            format!("{store}.m1@1/{store}")
        ]
    );
    assert_eq!(contents(&b), ["Builds use cargo."]);
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM memory_observations"),
        1
    );
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM primers"), 1);
}

#[tokio::test]
async fn observations_and_primers_travel_and_local_columns_stay() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.execute(
        "INSERT INTO memory_observations (content, proposed_category, session_id, project_id,
             source_start_ordinal, source_end_ordinal, created_at)
         VALUES ('Prefers short answers.', 'USER_PREFERENCES', 'ses-a', 'pj-a', 3, 4, 10);
         INSERT INTO primers (project_path, question, question_embedding, answer, total_support,
             source_candidate_ids, created_at, updated_at)
         VALUES ('pj-a', 'How are releases cut?', x'0102', 'From main.', 4, '[7, 8]', 10, 10);",
    );
    a.sync().await;
    b.sync().await;
    assert_eq!(
        b.texts("SELECT reason FROM replica_rejects"),
        Vec::<String>::new()
    );
    assert_eq!(
        b.texts("SELECT kind || ':' || global_id FROM replica_ids ORDER BY kind"),
        [
            format!("observation:{}.o1", a.store_id()),
            format!("primer:{}.p1", a.store_id())
        ]
    );
    assert_eq!(
        b.value::<String>(
            "SELECT content || '|' || session_id || '|' || COALESCE(source_start_ordinal, 'none') || '|' || project_id
               FROM memory_observations"
        ),
        "Prefers short answers.||none|pj-a"
    );
    assert_eq!(
        b.value::<String>(
            "SELECT question || '|' || answer || '|' || total_support || '|' || source_candidate_ids || '|' || COALESCE(question_embedding, 'none')
               FROM primers"
        ),
        "How are releases cut?|From main.|4|[]|none"
    );
    assert_eq!(
        hub.messages()
            .iter()
            .map(|message| message.subject.clone())
            .collect::<Vec<_>>(),
        [
            "ck.fleet.memory.observation.all",
            "ck.fleet.memory.primer.pj-a"
        ]
    );
    // The global review consumed it on A: B learns it was taken.
    a.execute("UPDATE memory_observations SET consumed_at = 50");
    a.sync().await;
    b.follow_all().await;
    assert_eq!(
        b.value::<i64>("SELECT consumed_at FROM memory_observations"),
        50
    );
}

#[tokio::test]
async fn metadata_keys_naming_this_computer_stay_and_the_rest_travel() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.execute(
        r#"INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
               first_seen_at, created_at, updated_at, last_seen_at, metadata_json)
           VALUES ('global', 'self', 'mc:user-unsorted', 'USER_MEMORY', 'Likes tea.', 'h', 1, 1, 1, 1,
                   '{"user_memory_id": 11, "promoted_at": 5, "source_candidate_ids": [3], "archive_reason": "kept"}')"#,
    );
    a.sync().await;
    b.sync().await;
    let metadata: serde_json::Value =
        serde_json::from_str(&b.value::<String>("SELECT metadata_json FROM memories")).unwrap();
    assert_eq!(
        metadata,
        serde_json::json!({"promoted_at": 5, "archive_reason": "kept"})
    );
    assert_eq!(hub.messages()[0].subject, "ck.fleet.memory.global.all");
    // B's own local key survives the next arrival.
    b.execute(
        r#"UPDATE memories SET metadata_json = json_set(metadata_json, '$.user_memory_id', 40)"#,
    );
    b.execute("DELETE FROM replica_outbox");
    a.execute(r#"UPDATE memories SET metadata_json = json_set(metadata_json, '$.promoted_at', 6)"#);
    a.sync().await;
    b.follow_all().await;
    let metadata: serde_json::Value =
        serde_json::from_str(&b.value::<String>("SELECT metadata_json FROM memories")).unwrap();
    assert_eq!(
        metadata,
        serde_json::json!({"promoted_at": 6, "archive_reason": "kept", "user_memory_id": 40})
    );
}

/// A sighting on A (the summarizer seeing a fact again) raises the memory's
/// revision there, with nothing replicated changed. It must never hold back
/// B's real edit on A, nor reach the hub.
#[tokio::test]
async fn a_sighting_never_wins_over_another_computers_edit() {
    use crate::summary::two_pass::applier::{admit, Admission};
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let text = "Releases need two reviewers.";
    memory(&a, "pj-a", text);
    a.sync().await;
    b.sync().await;
    b.execute(&format!(
        "UPDATE memories SET content = 'Releases need three reviewers.', normalized_hash = '{}'",
        crate::memory_writes::normalized_hash("Releases need three reviewers.")
    ));
    b.publish_all().await;
    let revision: i64 = a.value("SELECT revision FROM memories");
    a.db.with_connection(|conn| {
        let receipt = admit(
            conn,
            &Admission {
                key: "fact-seen-again",
                operation: "new",
                project: "pj-a",
                category: "ARCHITECTURE",
                content: text,
                source_session: "ses-1",
                memory_enabled: true,
                auto_promote: true,
                conflict_target: None,
                fact_id: 1,
                reservation: None,
                authority: None,
                owner: None,
                expires: None,
                line: None,
            },
        )
        .unwrap();
        assert_eq!(receipt.reason, "live_match");
    });
    assert_eq!(
        a.value::<i64>("SELECT revision FROM memories"),
        revision + 1,
        "the summarizer raised the revision of what it saw again"
    );
    assert_eq!(outbox(&a), ["memory:1:raised"]);
    a.follow_all().await;
    a.publish_all().await;
    b.follow_all().await;
    assert_eq!(contents(&a), ["Releases need three reviewers."]);
    assert_eq!(contents(&b), ["Releases need three reviewers."]);
    assert_eq!(hub.messages().len(), 2, "the sighting was never sent");
    assert!(outbox(&a).is_empty(), "the arrival cleared the raised row");
}

/// A is restored from a copy of its store taken before it published a
/// memory, then writes and publishes another. The new memory must not take
/// the global id the first one was sent under, so every computer ends with
/// both.
#[tokio::test]
async fn a_store_restored_from_an_earlier_copy_keeps_every_memory_on_every_computer() {
    let hub = InMemoryHub::new();
    let b = Computer::new(&hub, 2);
    b.sync().await;
    let a = Computer::new(&hub, 1);
    a.sync().await;
    let backup = a.copy();
    let before = a.store_id();
    memory(&a, "pj-a", "Written before the restore.");
    a.sync().await;
    b.follow_all().await;
    drop(a);
    let a = Computer::open(&hub, 1, backup);
    assert_eq!(
        a.store_id(),
        before,
        "the copy has the store id it was taken with"
    );
    memory(&a, "pj-a", "Written after the restore.");
    a.sync().await;
    b.follow_all().await;
    let both = ["Written after the restore.", "Written before the restore."];
    assert_eq!(b.live(), both);
    assert_eq!(a.live(), both);
    assert_ne!(
        a.store_id(),
        before,
        "the restored store found what a later state of it sent"
    );
    let ids: Vec<String> = hub
        .messages()
        .iter()
        .map(|message| message.message_id.clone().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            format!("{before}.m1@1/{before}"),
            format!("{now}.m1@1/{now}", now = a.store_id())
        ]
    );
}

/// A store copied to another computer takes a new store id there before it
/// sends anything, so the copy and the original never form one id twice.
#[tokio::test]
async fn a_store_copied_to_another_computer_takes_a_new_store_id() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Written on the original.");
    a.sync().await;
    let c = Computer::open(&hub, 3, a.copy());
    c.sync().await;
    assert_ne!(c.store_id(), a.store_id());
    memory(&c, "pj-a", "Written on the copy.");
    memory(&a, "pj-a", "Written on the original again.");
    c.sync().await;
    a.sync().await;
    a.follow_all().await;
    c.follow_all().await;
    let all = [
        "Written on the copy.",
        "Written on the original again.",
        "Written on the original.",
    ];
    assert_eq!(a.live(), all);
    assert_eq!(c.live(), all);
}

/// The vault opens nothing for now (a key it can't reach for the moment):
/// the round ends before the message and reads it again later, rather than
/// skipping it.
#[tokio::test]
async fn a_transient_vault_refusal_reads_the_message_again_later() {
    use super::seal::{OpenInput, Opened, SealError, SealInput, Sealed, Sealer};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Unreachable {
        sealer: Arc<super::test_support::TestSealer>,
        refuse: AtomicBool,
    }
    #[async_trait::async_trait]
    impl Sealer for Unreachable {
        async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError> {
            self.sealer.seal_batch(items).await
        }
        async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError> {
            if self.refuse.swap(false, Ordering::SeqCst) {
                return Ok(items
                    .iter()
                    .map(|_| Opened::Refused {
                        code: "store_error".into(),
                        class: "transient".into(),
                    })
                    .collect());
            }
            self.sealer.open_batch(items).await
        }
    }

    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Opened on the second try.");
    a.sync().await;
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap(),
    );
    let b = super::Replica::new(
        Arc::clone(&db),
        Arc::clone(&hub) as Arc<dyn super::hub::Hub>,
        Arc::new(Unreachable {
            sealer: super::test_support::TestSealer::new(super::test_support::KEY, 1),
            refuse: AtomicBool::new(true),
        }),
        super::test_support::box_of(2),
    );
    assert!(b.follow().await.is_err(), "the round ended");
    assert_eq!(b.position().unwrap(), 0);
    assert_eq!(b.follow().await.unwrap(), 1);
    let (rejected, arrived): (i64, i64) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM replica_rejects), (SELECT COUNT(*) FROM memories)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((rejected, arrived), (0, 1));
}

/// A body whose snapshot names another owner than the subject it was sealed
/// for and sent on is refused, so a row never lands under an owner the
/// stream didn't file it under.
#[tokio::test]
async fn a_snapshot_under_another_owners_subject_is_rejected() {
    use super::seal::{OpenInput, Opened, SealInput, Sealer};
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Filed under pj-a.");
    a.sync().await;
    let sent = hub.messages()[0].clone();
    let envelope: wire::Envelope = serde_json::from_slice(&sent.payload).unwrap();
    let sealer = super::test_support::TestSealer::new(super::test_support::KEY, 1);
    let opened = sealer
        .open_batch(&[OpenInput {
            epoch: envelope.epoch,
            nonce: envelope.nonce.clone(),
            ciphertext: envelope.ciphertext.clone(),
            aad: wire::aad(&envelope.global_id, envelope.revision, &sent.subject),
        }])
        .await
        .unwrap();
    let Opened::Plaintext(bytes) = &opened[0] else {
        panic!("the message opens");
    };
    let mut body: wire::Body = serde_json::from_slice(bytes).unwrap();
    let snapshot = body.snapshot.as_mut().unwrap();
    snapshot.insert("owner_id".into(), serde_json::json!("pj-b"));
    let resealed = sealer
        .seal_batch(&[SealInput {
            aad: wire::aad(&body.global_id, body.revision, &sent.subject),
            plaintext: zeroize::Zeroizing::new(body.to_bytes()),
        }])
        .await
        .unwrap()
        .remove(0);
    let forged = wire::Envelope {
        epoch: resealed.epoch,
        nonce: resealed.nonce,
        ciphertext: resealed.ciphertext,
        ..envelope
    };
    // Another computer reads a stream holding only the forged message.
    let forged_stream = InMemoryHub::new();
    forged_stream.inject(&sent.subject, Some("forged@1"), forged.to_bytes());
    let b = Computer::new(&forged_stream, 2);
    b.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memories"), 0);
    assert_eq!(
        b.value::<String>("SELECT reason FROM replica_rejects"),
        "the snapshot belongs on ck.fleet.memory.project.pj-b, not on the subject it came on"
    );
}

/// Two computers write the same fact, one changes its text before it hears
/// of the other's, and a third joins only afterwards: all three end with the
/// same rows and the same live ones.
#[tokio::test]
async fn a_computer_joining_late_ends_with_the_same_live_rows() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    b.replica.join().await.unwrap();
    memory(&a, "pj-a", "Releases need two reviewers.");
    a.sync().await;
    memory(&b, "pj-a", "Releases need two reviewers.");
    b.publish_all().await;
    a.execute(&format!(
        "UPDATE memories SET content = 'Releases need three reviewers.', normalized_hash = '{}'",
        crate::memory_writes::normalized_hash("Releases need three reviewers.")
    ));
    a.publish_all().await;
    a.follow_all().await;
    b.follow_all().await;
    let c = Computer::new(&hub, 3);
    c.sync().await;
    for computer in [&b, &c] {
        assert_eq!(computer.live(), a.live());
        assert_eq!(rows(computer), rows(&a));
    }
    assert_eq!(
        a.live(),
        [
            "Releases need three reviewers.",
            "Releases need two reviewers."
        ]
    );
}

/// A store that holds another store's id (a copy whose box id didn't tell
/// it apart) and reads a message sent under that id by another computer,
/// a message it doesn't know, takes a new store id before it sends
/// anything: whichever computer sent the message.
#[tokio::test]
async fn a_message_under_this_stores_id_from_another_computer_gives_it_a_new_store_id() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.sync().await;
    b.sync().await;
    let taken = a.store_id();
    b.execute(&format!(
        "UPDATE replica_state SET store_id = '{taken}' WHERE id = 1"
    ));
    memory(&a, "pj-a", "Written on A under its store id.");
    a.publish_all().await;
    b.follow_all().await;
    assert_ne!(b.store_id(), taken, "B no longer forms A's global ids");
    memory(&b, "pj-a", "Written on B afterwards.");
    b.sync().await;
    a.follow_all().await;
    assert_eq!(a.live(), b.live());
    assert_eq!(a.live().len(), 2);
}

/// The hub's stream is made anew with the same creation time but fewer
/// messages than the position a computer stored: it is still a stream made
/// anew, read from its start, and the computer sends every row it holds
/// again, so computers that join the new stream get them.
#[tokio::test]
async fn a_stream_shorter_than_the_stored_position_is_read_from_its_start_and_every_row_sent_again()
{
    let old = InMemoryHub::named("the same creation time");
    let a = Computer::new(&old, 1);
    for text in ["First memory on A.", "Second memory on A."] {
        memory(&a, "pj-a", text);
    }
    a.sync().await;
    assert_eq!(a.replica.position().unwrap(), 2);

    let new = InMemoryHub::named("the same creation time");
    let c = Computer::new(&new, 3);
    memory(&c, "pj-a", "Written on C on the new stream.");
    c.sync().await;
    let a = Computer::open(&new, 1, a.copy());
    a.sync().await;
    c.follow_all().await;
    let all = [
        "First memory on A.",
        "Second memory on A.",
        "Written on C on the new stream.",
    ];
    assert_eq!(a.live(), all);
    assert_eq!(c.live(), all, "A's rows reached the new stream");
    assert!(outbox(&a).is_empty());
}

/// A round stops publishing at its first unconfirmed send: with a hub that
/// takes the connection but doesn't answer, one round never waits once per
/// row. The rows wait as `sending`, and the next round sends each once.
#[tokio::test]
async fn a_round_stops_publishing_at_its_first_unconfirmed_send() {
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    a.replica.join().await.unwrap();
    for text in ["One.", "Two.", "Three."] {
        memory(&a, "pj-a", text);
    }
    hub.refuse_next(1);
    assert!(a.replica.publish().await.is_err());
    assert_eq!(hub.publish_calls(), 1, "nothing more was tried this round");
    assert_eq!(
        outbox(&a),
        ["memory:1:sending", "memory:2:sending", "memory:3:sending"]
    );
    a.publish_all().await;
    assert_eq!(hub.messages().len(), 3);
    assert_eq!(hub.publish_calls(), 4);
}

/// A person deleted a memory on A while B was away, so B still holds it.
/// Then the hub's stream is made anew. Both computers send every row again,
/// and A sends the tombstone too: B, and a computer that joins the new
/// stream, delete the memory, so every computer ends with the same rows.
#[tokio::test]
async fn a_delete_in_the_old_streams_history_reaches_every_computer_after_the_stream_is_made_anew()
{
    let old = InMemoryHub::new();
    let (a, b) = (Computer::new(&old, 1), Computer::new(&old, 2));
    let gone = memory(&a, "pj-a", "Deleted on A while B was away.");
    memory(&a, "pj-a", "Kept everywhere.");
    a.sync().await;
    b.sync().await;
    a.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, gone).unwrap();
        tx.commit().unwrap();
    });
    a.sync().await;
    assert_eq!(b.live().len(), 2, "B never read the delete");

    let new = InMemoryHub::new();
    let b = Computer::open(&new, 2, b.copy());
    b.sync().await;
    let a = Computer::open(&new, 1, a.copy());
    a.sync().await;
    b.follow_all().await;
    let c = Computer::new(&new, 3);
    c.sync().await;
    for computer in [&a, &b, &c] {
        assert_eq!(computer.live(), ["Kept everywhere."]);
    }
    assert_eq!(
        b.value::<i64>("SELECT COUNT(*) FROM memories"),
        1,
        "the deleted memory is gone from B, not only archived"
    );
}

/// The hub's stream is restored from a backup of the hub, which keeps the
/// stream's creation time but holds fewer messages than A had read, and
/// another computer sends past A's position before A starts again. The
/// message the stream now holds at A's position is another one than A read
/// there, so the stream was made anew all the same: A must read it from
/// its start, or it skips C's first memories for good, and must send its
/// rows again, or C never gets the ones the backup lost.
#[tokio::test]
async fn a_stream_restored_with_the_same_creation_time_is_read_from_its_start() {
    let old = InMemoryHub::named("a stream later restored from a backup");
    let a = Computer::new(&old, 1);
    for text in [
        "First memory on A.",
        "Second memory on A.",
        "Third memory on A.",
    ] {
        memory(&a, "pj-a", text);
    }
    a.sync().await;
    assert_eq!(a.replica.position().unwrap(), 3);

    let restored = InMemoryHub::named("a stream later restored from a backup");
    let kept = old.messages()[0].clone();
    restored.inject(&kept.subject, kept.message_id.as_deref(), kept.payload);
    let c = Computer::new(&restored, 3);
    for text in [
        "First memory on C.",
        "Second memory on C.",
        "Third memory on C.",
    ] {
        memory(&c, "pj-a", text);
    }
    c.sync().await;
    assert_eq!(restored.messages().len(), 4, "C sent past A's position");

    let a = Computer::open(&restored, 1, a.copy());
    a.sync().await;
    c.follow_all().await;
    let all = [
        "First memory on A.",
        "First memory on C.",
        "Second memory on A.",
        "Second memory on C.",
        "Third memory on A.",
        "Third memory on C.",
    ];
    assert_eq!(a.live(), all, "A reads C's memories");
    assert_eq!(c.live(), all, "A's memories the backup lost reach C");
}

/// A's send of an edit is stored, but its acknowledgement is lost. B, which
/// hasn't read it, edits the same memory at the same revision, and its
/// change is stored after A's. A then sends its edit again after the hub's
/// duplicate window has passed, and the hub stores it once more. That copy
/// is the message every computer already applied: every computer must skip
/// it, so B's edit, later in the stream at the same revision, holds
/// everywhere, and A must not take the copy for a message of a copy of its
/// store.
#[tokio::test]
async fn a_send_stored_again_after_the_duplicate_window_is_applied_once() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    hub.lose_next_acks(1);
    assert!(a.replica.publish().await.is_err(), "the ack is lost");
    b.execute("UPDATE memories SET content = 'Releases need three reviewers.'");
    b.publish_all().await;
    hub.forget_ids();
    let store = a.store_id();
    a.publish_all().await;
    assert_eq!(hub.messages().len(), 4, "A's edit is stored twice");
    a.follow_all().await;
    b.follow_all().await;
    for computer in [&a, &b] {
        assert_eq!(contents(computer), ["Releases need three reviewers."]);
    }
    assert_eq!(a.store_id(), store, "A knows its own message");
}

/// A person on A edits a memory, and the send is never confirmed. Then B
/// deletes the memory, and A applies the delete. The hub's stream is made
/// anew, and A sends the delete to it again, as every deleted row's. A's
/// unconfirmed edit must not settle that delete away when it comes back
/// from the new stream: a computer that joins the new stream must not hold
/// the memory.
#[tokio::test]
async fn a_delete_sent_to_a_stream_made_anew_is_never_settled_by_an_older_own_change() {
    let old = InMemoryHub::new();
    let (a, b) = (Computer::new(&old, 1), Computer::new(&old, 2));
    let gone = memory(&a, "pj-a", "Deleted on B, edited on A.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Edited on A before the delete arrived.'");
    old.refuse_next(1);
    assert!(
        a.replica.publish().await.is_err(),
        "A's edit is unconfirmed"
    );
    b.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        crate::memory_writes::person::purge(&tx, gone).unwrap();
        tx.commit().unwrap();
    });
    b.sync().await;
    a.follow_all().await;
    assert_eq!(a.value::<i64>("SELECT COUNT(*) FROM memories"), 0);

    let new = InMemoryHub::new();
    let a = Computer::open(&new, 1, a.copy());
    a.replica.join().await.unwrap();
    // The first send of this round goes through; the next is refused.
    new.refuse_after(1);
    let _ = a.replica.publish().await;
    a.replica.round().await.unwrap();
    a.publish_all().await;
    let c = Computer::new(&new, 3);
    c.sync().await;
    assert_eq!(
        c.value::<i64>("SELECT COUNT(*) FROM memories"),
        0,
        "the delete reached the new stream"
    );
}
