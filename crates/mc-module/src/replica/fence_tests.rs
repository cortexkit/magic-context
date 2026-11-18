//! A receiver's fence on dreamer changes: a change written under a lease
//! generation older than the newest this computer has seen for the role is
//! recorded and skipped.

use super::hub::InMemoryHub;
use super::test_support::{memory, Computer};

const ROLE: &str = "dreamer.pj-a";

/// A memory of `pj-a` that the dreamer writes on `computer`, under
/// generation `gen` of the project's role.
fn dreamed(computer: &Computer, content: &str, gen: i64) {
    computer.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        super::name_writer(&tx, "dreamer", Some(1), &[(ROLE.to_owned(), gen)]).unwrap();
        tx.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, source_type)
             VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', ?1, ?2, 1, 1, 1, 1, 'dreamer')",
            rusqlite::params![content, crate::memory_writes::normalized_hash(content)],
        )
        .unwrap();
        super::unname_writer(&tx).unwrap();
        tx.commit().unwrap();
    });
}

fn contents(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT content FROM memories ORDER BY content")
}

fn rejects(computer: &Computer) -> Vec<String> {
    computer.texts("SELECT reason FROM replica_rejects ORDER BY id")
}

/// A applies a dreamer change under generation 5 of the role; one written
/// afterwards under generation 4, by a computer that had lost the role, is
/// skipped with the reason. A change of the same generation, and one no
/// dreamer wrote, still apply.
#[tokio::test]
async fn a_receiver_skips_a_dreamer_change_with_an_older_epoch() {
    let hub = InMemoryHub::new();
    let (a, b, stale) = (
        Computer::new(&hub, 1),
        Computer::new(&hub, 2),
        Computer::new(&hub, 3),
    );
    for computer in [&a, &b, &stale] {
        computer.replica.join().await.unwrap();
    }
    dreamed(&a, "Written by the holder.", 5);
    a.publish_all().await;
    dreamed(&stale, "Written by a former holder.", 4);
    stale.publish_all().await;
    dreamed(&a, "Written by the holder again.", 5);
    memory(&stale, "pj-a", "Written by a person.");
    a.publish_all().await;
    stale.publish_all().await;
    b.follow_all().await;

    assert_eq!(
        contents(&b),
        [
            "Written by a person.",
            "Written by the holder again.",
            "Written by the holder."
        ]
    );
    assert_eq!(
        rejects(&b),
        ["a dreamer change written under generation 4 of dreamer.pj-a, older than the role's fence 5"]
    );
    assert_eq!(
        b.value::<i64>("SELECT epoch FROM replica_fences WHERE role = 'dreamer.pj-a'"),
        5
    );
    assert_eq!(
        b.replica.position().unwrap(),
        4,
        "the skipped change is passed over"
    );
}

/// The leases this computer's own dreamer held count too: a change under
/// a generation older than one its journal records is skipped.
#[tokio::test]
async fn a_receiver_fences_by_the_leases_its_own_dreamer_held() {
    let hub = InMemoryHub::new();
    let (a, b) = (Computer::new(&hub, 1), Computer::new(&hub, 2));
    a.replica.join().await.unwrap();
    b.replica.join().await.unwrap();
    b.execute(&format!(
        "INSERT INTO dream_task_runs (task, kind, level, owner_id, profile, started_at, leases_json)
         VALUES ('swe:curate', 'curate', 'project', 'pj-a', 'swe', 1, '{{\"{ROLE}\": 7}}')"
    ));
    dreamed(&a, "Written under an older lease.", 6);
    dreamed(&a, "Written under the newest lease.", 7);
    a.publish_all().await;
    b.follow_all().await;

    assert_eq!(contents(&b), ["Written under the newest lease."]);
    assert_eq!(
        rejects(&b),
        ["a dreamer change written under generation 6 of dreamer.pj-a, older than the role's fence 7"]
    );
}
