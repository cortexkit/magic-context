//! The 0.49 plugin's primer clustering and storage cases
//! (`primer-clustering.test.ts`, `storage-primers.test.ts`), ported, with
//! the promotion step's writes and pruning.

use super::*;
use crate::context_db::ContextDb;

const PROJECT: &str = "pj-primers";
const DAY: i64 = DAY_MS;
/// 2026-01-01T00:00:00Z.
const JAN_1: i64 = 1_767_225_600_000;

fn candidate(id: i64) -> Candidate {
    Candidate {
        id,
        project: PROJECT.into(),
        harness: "opencode".into(),
        session: "ses".into(),
        question: "How does caching work?".into(),
        normalized: "how does caching work".into(),
        compartment_start: Some(1),
        compartment_end: Some(5),
        start_message_id: format!("start_{id}"),
        end_message_id: format!("end_{id}"),
        source_time: JAN_1,
        embedding: Some(vec![1.0, 0.0]),
        model: Some("model-a".into()),
    }
}

fn primer(id: i64, sources: &[i64]) -> Primer {
    Primer {
        id,
        project: PROJECT.into(),
        question: "How does caching work?".into(),
        embedding: Some(vec![1.0, 0.0]),
        model: Some("model-a".into()),
        answer: String::new(),
        support: 1,
        last_observed_at: Some(JAN_1),
        answer_refreshed_at: None,
        sources: sources.to_vec(),
        created_at: JAN_1,
        updated_at: JAN_1,
    }
}

fn ids(cluster: &Cluster) -> Vec<i64> {
    cluster
        .candidates
        .iter()
        .map(|candidate| candidate.id)
        .collect()
}

/// A unit vector at `similarity` cosine from `[1, 0]`.
fn at(similarity: f32) -> Vec<f32> {
    vec![similarity, (1.0 - similarity * similarity).sqrt()]
}

// --- Clustering ---

#[test]
fn recurrence_counts_unique_utc_occurrence_days_not_candidate_rows() {
    let candidates = [
        Candidate {
            source_time: JAN_1 + 7 * DAY,
            start_message_id: "s2".into(),
            end_message_id: "e2".into(),
            ..candidate(2)
        },
        Candidate {
            start_message_id: "s1".into(),
            end_message_id: "e1".into(),
            ..candidate(1)
        },
        Candidate {
            source_time: JAN_1 + 12 * 60 * 60 * 1000,
            start_message_id: "s3".into(),
            end_message_id: "e3".into(),
            ..candidate(3)
        },
    ];
    let clusters = build_clusters(&candidates, &[], CLUSTER_THRESHOLD, CLUSTER_HYSTERESIS);
    assert_eq!(clusters.len(), 1);
    let summary = summarize(&clusters[0], JAN_1 + 30 * DAY);
    assert_eq!((summary.support, summary.span_days), (2, 7));
    assert_eq!(summary.last_observed_at, JAN_1 + 7 * DAY);
    assert_eq!(summary.sources, vec![1, 2, 3]);
    assert!(eligible(&summary, 2, 7));
}

#[test]
fn candidates_are_ordered_by_utf16_code_unit_including_separators_and_accents() {
    let named = |id: i64, start: &str| Candidate {
        start_message_id: start.into(),
        end_message_id: "a".into(),
        ..candidate(id)
    };
    let candidates = [
        named(1, "s10"),
        named(2, "s1"),
        named(3, "a"),
        named(4, "A"),
        named(5, "\u{e9}"),
        named(6, "z"),
    ];
    let clusters = build_clusters(&candidates, &[], CLUSTER_THRESHOLD, CLUSTER_HYSTERESIS);
    assert_eq!(clusters.len(), 1);
    assert_eq!(ids(&clusters[0]), vec![4, 3, 2, 1, 6, 5]);
}

#[test]
fn clustering_does_not_depend_on_input_order() {
    let inputs = vec![
        Candidate {
            start_message_id: "a".into(),
            end_message_id: "b".into(),
            ..candidate(1)
        },
        Candidate {
            start_message_id: "c".into(),
            end_message_id: "d".into(),
            ..candidate(2)
        },
        Candidate {
            embedding: Some(vec![0.0, 1.0]),
            normalized: "how do leases work".into(),
            start_message_id: "e".into(),
            end_message_id: "f".into(),
            ..candidate(3)
        },
    ];
    let mut reversed = inputs.clone();
    reversed.reverse();
    let forward = build_clusters(&inputs, &[], CLUSTER_THRESHOLD, CLUSTER_HYSTERESIS);
    let backward = build_clusters(&reversed, &[], CLUSTER_THRESHOLD, CLUSTER_HYSTERESIS);
    assert_eq!(
        forward.iter().map(ids).collect::<Vec<_>>(),
        backward.iter().map(ids).collect::<Vec<_>>()
    );
    assert_eq!(
        forward.iter().map(ids).collect::<Vec<_>>(),
        vec![vec![1, 2], vec![3]]
    );
}

#[test]
fn similarity_must_reach_the_threshold_and_a_primers_own_source_gets_the_hysteresis() {
    // 0.84 is under the threshold of 0.85 but over the 0.83 a candidate the
    // primer already counts needs.
    let counted = Candidate {
        embedding: Some(at(0.84)),
        ..candidate(1)
    };
    let clusters = build_clusters(
        &[counted],
        &[primer(9, &[1])],
        CLUSTER_THRESHOLD,
        CLUSTER_HYSTERESIS,
    );
    assert_eq!(clusters.len(), 1);
    assert_eq!(clusters[0].primer.as_ref().unwrap().id, 9);
    assert_eq!(ids(&clusters[0]), vec![1]);
    let stranger = Candidate {
        embedding: Some(at(0.84)),
        ..candidate(2)
    };
    let clusters = build_clusters(
        &[stranger],
        &[primer(9, &[1])],
        CLUSTER_THRESHOLD,
        CLUSTER_HYSTERESIS,
    );
    assert_eq!(ids(&clusters[0]), Vec::<i64>::new());
    assert_eq!(
        ids(&clusters[1]),
        vec![2],
        "a stranger at 0.84 starts its own cluster"
    );
    // At 0.86 a stranger joins too.
    let close = Candidate {
        embedding: Some(at(0.86)),
        ..candidate(3)
    };
    let clusters = build_clusters(
        &[close],
        &[primer(9, &[])],
        CLUSTER_THRESHOLD,
        CLUSTER_HYSTERESIS,
    );
    assert_eq!(clusters.len(), 1);
    assert_eq!(ids(&clusters[0]), vec![3]);
}

#[test]
fn questions_without_a_shared_embedding_model_cluster_by_normalized_text() {
    let other_model = Candidate {
        model: Some("model-b".into()),
        embedding: Some(vec![0.0, 1.0]),
        ..candidate(2)
    };
    let no_vector = Candidate {
        embedding: None,
        model: None,
        ..candidate(3)
    };
    let different = Candidate {
        embedding: None,
        model: None,
        normalized: "how do leases work".into(),
        ..candidate(4)
    };
    let clusters = build_clusters(
        &[candidate(1), other_model, no_vector, different],
        &[],
        CLUSTER_THRESHOLD,
        CLUSTER_HYSTERESIS,
    );
    assert_eq!(
        clusters.iter().map(ids).collect::<Vec<_>>(),
        vec![vec![1, 2, 3], vec![4]]
    );
    // The centroid is the average of the vectors in the cluster's model.
    assert_eq!(clusters[0].centroid, Some(vec![1.0, 0.0]));
    // A cluster of a primer without candidates yet matches by its question,
    // normalized as a candidate's is.
    let clusters = build_clusters(
        &[Candidate {
            embedding: None,
            model: None,
            ..candidate(5)
        }],
        &[Primer {
            question: "  How does Caching   work?  ".into(),
            embedding: None,
            ..primer(9, &[])
        }],
        CLUSTER_THRESHOLD,
        CLUSTER_HYSTERESIS,
    );
    assert_eq!(clusters.len(), 1, "{clusters:?}");
}

#[test]
fn a_cluster_needs_two_days_spanning_seven() {
    let day = |id: i64, days: i64| Candidate {
        source_time: JAN_1 + days * DAY,
        ..candidate(id)
    };
    let summary = |candidates: Vec<Candidate>| {
        summarize(
            &Cluster {
                primer: None,
                candidates,
                centroid: None,
                model: None,
            },
            JAN_1 + 60 * DAY,
        )
    };
    let six = summary(vec![day(1, 0), day(2, 6)]);
    assert_eq!((six.support, six.span_days), (2, 6));
    assert!(!eligible(&six, PROMOTION_THRESHOLD, MIN_SPAN_DAYS));
    let one = summary(vec![day(1, 0)]);
    assert_eq!((one.support, one.span_days), (1, 0));
    assert!(!eligible(&one, PROMOTION_THRESHOLD, MIN_SPAN_DAYS));
    // The same source occurrence counts once, whatever the day.
    let same = summary(vec![
        day(1, 0),
        Candidate {
            source_time: JAN_1 + 9 * DAY,
            ..candidate(1)
        },
    ]);
    assert_eq!(same.support, 1);
    let seven = summary(vec![day(1, 0), day(2, 7), day(3, 7)]);
    assert_eq!((seven.support, seven.span_days), (2, 7));
    assert!(eligible(&seven, PROMOTION_THRESHOLD, MIN_SPAN_DAYS));
}

#[test]
fn recurrence_uses_fixed_utc_calendar_days() {
    let minute = 60 * 1000;
    assert_eq!(utc_day(JAN_1 + DAY - minute), utc_day(JAN_1));
    assert_eq!(utc_day(JAN_1 + DAY + minute), utc_day(JAN_1) + 1);
}

#[test]
fn a_new_primer_takes_its_oldest_question_ending_with_a_question_mark() {
    let candidates = [
        Candidate {
            question: "  How do leases expire  ".into(),
            source_time: JAN_1 + 3 * DAY,
            ..candidate(1)
        },
        Candidate {
            question: "How does the lease expire".into(),
            ..candidate(2)
        },
    ];
    assert_eq!(
        canonical_question(&candidates),
        "How does the lease expire?"
    );
    assert_eq!(
        canonical_question(&[Candidate {
            question: "Why?".into(),
            ..candidate(3)
        }]),
        "Why?"
    );
    assert_eq!(
        canonical_question(&[Candidate {
            question: "   ".into(),
            ..candidate(3)
        }]),
        "How does this project subsystem work?"
    );
}

// --- The store ---

fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, db)
}

/// Store `candidate` as a row of `primer_candidates`.
pub(crate) fn insert_candidate(conn: &Connection, candidate: &Candidate) {
    conn.execute(
        "INSERT INTO primer_candidates (id, project_path, harness, session_id, question, normalized_question,
             source_compartment_start, source_compartment_end, source_start_message_id, source_end_message_id,
             source_message_time, question_embedding, question_embedding_model_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1)",
        params![
            candidate.id,
            candidate.project,
            candidate.harness,
            candidate.session,
            candidate.question,
            candidate.normalized,
            candidate.compartment_start,
            candidate.compartment_end,
            candidate.start_message_id,
            candidate.end_message_id,
            candidate.source_time,
            candidate.embedding.as_deref().map(crate::embedding::encode),
            candidate.model,
        ],
    )
    .unwrap();
}

/// Store `primer` as a row of `primers`, with `status`.
pub(crate) fn insert_primer(conn: &Connection, primer: &Primer, status: &str) {
    conn.execute(
        "INSERT INTO primers (id, project_path, question, question_embedding, question_embedding_model_id,
             answer, status, total_support, last_observed_at, answer_refreshed_at, source_candidate_ids,
             source_candidate_provenance, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13)",
        params![
            primer.id,
            primer.project,
            primer.question,
            primer.embedding.as_deref().map(crate::embedding::encode),
            primer.model,
            primer.answer,
            status,
            primer.support,
            primer.last_observed_at,
            primer.answer_refreshed_at,
            serde_json::to_string(&primer.sources).unwrap(),
            primer.created_at,
            primer.updated_at,
        ],
    )
    .unwrap();
}

#[test]
fn pruning_keeps_an_active_primers_sources_until_the_hard_limit() {
    let (_dir, db) = store();
    let now = JAN_1 + 400 * DAY;
    db.with_connection(|conn| {
        let aged = |id: i64, days: i64| Candidate {
            source_time: now - days * DAY,
            ..candidate(id)
        };
        for candidate in [
            aged(1, 100),
            aged(2, 100),
            aged(3, 200),
            aged(4, 10),
            aged(5, 100),
        ] {
            insert_candidate(conn, &candidate);
        }
        insert_candidate(
            conn,
            &Candidate {
                project: "pj-other".into(),
                ..aged(6, 100)
            },
        );
        insert_primer(conn, &primer(1, &[2, 3]), "active");
        insert_primer(conn, &primer(2, &[5]), "archived");
        assert_eq!(prune(conn, PROJECT, now).unwrap(), 3);
        let left: Vec<i64> = conn
            .prepare("SELECT id FROM primer_candidates ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        // 1: old; 3: past the hard limit; 5: only an archived primer counts
        // it; 6: another project's.
        assert_eq!(left, vec![2, 4, 6]);
    });
}

#[test]
fn promotion_creates_an_eligible_primer_and_updates_a_matching_one() {
    let (_dir, db) = store();
    let now = JAN_1 + 30 * DAY;
    db.with_connection(|conn| {
        // Asked on two days a week apart: a new primer.
        for (id, days, question) in [
            (1, 0, "How do leases expire"),
            (2, 8, "How do the leases expire"),
        ] {
            insert_candidate(
                conn,
                &Candidate {
                    question: question.into(),
                    normalized: "how do leases expire".into(),
                    embedding: None,
                    model: None,
                    source_time: JAN_1 + days * DAY,
                    ..candidate(id)
                },
            );
        }
        // Asked once: no primer.
        insert_candidate(
            conn,
            &Candidate {
                question: "Where are the logs".into(),
                normalized: "where are the logs".into(),
                embedding: Some(vec![0.0, 1.0]),
                ..candidate(3)
            },
        );
        // Asked again for an active primer that counts candidate 4.
        insert_candidate(
            conn,
            &Candidate {
                source_time: JAN_1 + 2 * DAY,
                ..candidate(4)
            },
        );
        insert_candidate(
            conn,
            &Candidate {
                source_time: JAN_1 + 20 * DAY,
                embedding: Some(at(0.95)),
                ..candidate(5)
            },
        );
        insert_primer(conn, &primer(1, &[4]), "active");
        let done = promote(conn, PROJECT, now).unwrap();
        assert_eq!(
            done,
            Promoted {
                candidates: 5,
                promoted: 1,
                updated: 1,
            }
        );
        let primers = active_primers(conn, PROJECT).unwrap();
        let updated = primers.iter().find(|primer| primer.id == 1).unwrap();
        assert_eq!(updated.sources, vec![4, 5]);
        assert_eq!(updated.support, 2);
        assert_eq!(updated.last_observed_at, Some(JAN_1 + 20 * DAY));
        assert_eq!(updated.updated_at, now);
        assert_eq!(
            updated.embedding,
            Some(vec![(1.0f32 + 0.95) / 2.0, at(0.95)[1] / 2.0]),
            "the centroid of the cluster's vectors"
        );
        let new = primers.iter().find(|primer| primer.id != 1).unwrap();
        assert_eq!(new.question, "How do leases expire?");
        assert_eq!((new.support, new.sources.clone()), (2, vec![1, 2]));
        assert_eq!(new.answer, "");
        assert_eq!(new.answer_refreshed_at, None);
        assert_eq!((new.created_at, new.updated_at), (now, now));
        let provenance: String = conn
            .query_row(
                "SELECT source_candidate_provenance FROM primers WHERE id = ?1",
                [new.id],
                |row| row.get(0),
            )
            .unwrap();
        let provenance: Vec<Value> = serde_json::from_str(&provenance).unwrap();
        assert_eq!(
            provenance
                .iter()
                .map(|record| record["candidate_id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(provenance[0]["session_id"], "ses");
        // Running again finds both primers: the new one matches its own
        // questions by text, whose trailing question mark the candidates'
        // normalized text drops, so no duplicate is promoted.
        let again = promote(conn, PROJECT, now).unwrap();
        assert_eq!((again.promoted, again.updated), (0, 2));
        assert_eq!(active_primers(conn, PROJECT).unwrap().len(), 2);
    });
}

#[test]
fn an_updated_primer_keeps_the_provenance_of_a_pruned_source() {
    let (_dir, db) = store();
    let now = JAN_1 + 30 * DAY;
    db.with_connection(|conn| {
        insert_candidate(
            conn,
            &Candidate {
                source_time: JAN_1 + 8 * DAY,
                session: "ses_second".into(),
                ..candidate(2)
            },
        );
        insert_primer(conn, &primer(1, &[1, 2]), "active");
        conn.execute(
            "UPDATE primers SET source_candidate_provenance = ?1 WHERE id = 1",
            [json!([{
                "candidate_id": 1, "project_path": PROJECT, "harness": "opencode",
                "session_id": "ses_first", "source_compartment_start": null,
                "source_compartment_end": null, "source_start_message_id": "msg_1",
                "source_end_message_id": "msg_3"
            }])
            .to_string()],
        )
        .unwrap();
        promote(conn, PROJECT, now).unwrap();
        let provenance: String = conn
            .query_row(
                "SELECT source_candidate_provenance FROM primers WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let provenance: Vec<Value> = serde_json::from_str(&provenance).unwrap();
        assert_eq!(
            provenance
                .iter()
                .map(|record| (
                    record["candidate_id"].as_i64().unwrap(),
                    record["session_id"].as_str().unwrap().to_owned()
                ))
                .collect::<Vec<_>>(),
            vec![(1, "ses_first".to_owned()), (2, "ses_second".to_owned())]
        );
    });
}
