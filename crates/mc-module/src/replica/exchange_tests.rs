//! Two (or three) stores exchanging messages through one in-memory hub, as
//! a user's computers do through theirs.

use std::sync::Arc;

use super::hub::InMemoryHub;
use super::test_support::{box_of, memory, Computer};
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
    let global = wire::global_id(&box_of(1), "memory", id);
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
    assert_eq!(writers(&hub), [box_of(1)]);
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
/// change. Both send under the same revision; the hub keeps the first, and
/// both end with it, the replaced text in the other's history.
#[tokio::test]
async fn concurrent_edits_under_one_revision_converge_with_the_replaced_text_in_history() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    memory(&a, "pj-a", "Releases need one reviewer.");
    a.sync().await;
    b.sync().await;
    a.execute("UPDATE memories SET content = 'Releases need two reviewers.'");
    b.execute("UPDATE memories SET content = 'Releases need three reviewers.'");
    a.publish_all().await;
    b.publish_all().await;
    a.follow_all().await;
    b.follow_all().await;
    assert_eq!(contents(&a), ["Releases need two reviewers."]);
    assert_eq!(contents(&b), ["Releases need two reviewers."]);
    assert_eq!(
        b.texts("SELECT previous_text FROM memory_history"),
        ["Releases need three reviewers."]
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

#[tokio::test]
async fn the_same_fact_written_on_two_computers_links_instead_of_duplicating() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    let first = memory(&a, "pj-a", "Releases need two reviewers.");
    let second = memory(&b, "pj-a", "Releases need two reviewers.");
    a.sync().await;
    b.sync().await;
    a.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memories"), 1);
    assert_eq!(a.value::<i64>("SELECT COUNT(*) FROM memories"), 1);
    let global = wire::global_id(&box_of(1), "memory", first);
    assert_eq!(
        b.value::<i64>(&format!(
            "SELECT local_id FROM replica_ids WHERE global_id = '{global}'"
        )),
        second
    );
    assert_eq!(
        hub.messages().len(),
        1,
        "only the first computer's create was sent"
    );
    // A later change on B travels under the shared id.
    b.execute("UPDATE memories SET importance = 77");
    b.sync().await;
    a.follow_all().await;
    assert_eq!(a.value::<i64>("SELECT importance FROM memories"), 77);
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
        .starts_with(&wire::global_id(&box_of(1), "memory", survivor)));
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
            "3:not opened: fleet_epoch_open_failed"
        ]
    );
    assert_eq!(b.replica.position().unwrap(), 4);
}

#[tokio::test]
async fn a_joining_computer_applies_the_history_first_and_converges_without_duplicates() {
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
    let expected = ["Only on A.", "Only on B, archived.", "Shared fact."];
    assert_eq!(contents(&a), expected);
    assert_eq!(contents(&b), expected);
    assert_eq!(
        a.value::<String>("SELECT status FROM memories WHERE content = 'Only on B, archived.'"),
        "archived"
    );
    assert_eq!(hub.messages().len(), 3);
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
    // A late snapshot from a computer that hadn't seen the delete.
    hub.inject(&create.subject, Some("late@9"), create.payload.clone());
    b.follow_all().await;
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM memories"), 0);
    assert_eq!(
        b.value::<String>("SELECT reason FROM replica_rejects"),
        "the row was deleted"
    );
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
        Some(format!("{}@2", wire::global_id(&box_of(1), "memory", 1)).as_str())
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
    let boxed = box_of(1);
    assert_eq!(
        ids,
        [
            format!("{boxed}.o1@1"),
            format!("{boxed}.p1@1"),
            format!("{boxed}.m1@1")
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
            format!("observation:{}.o1", box_of(1)),
            format!("primer:{}.p1", box_of(1))
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
