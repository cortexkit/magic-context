use super::*;

#[test]
fn fact_probes_preserve_exact_dedup_and_highest_watermark_across_batches() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let mut facts: Vec<_> = (0..260)
        .map(|i| FactCandidate {
            category: "ARCHITECTURE".into(),
            content: format!("fact {i}"),
            importance: Some(50),
            source_session_id: None,
            expires_at: None,
        })
        .collect();
    facts.push(facts[0].clone());
    facts.push(FactCandidate {
        content: " fact 0 ".into(),
        ..facts[0].clone()
    });
    store.context_write(context_writes::HISTORY_TABLES, |tx| {
        let promoted = promote_facts_tx(tx,"p",&facts,100)?;
        assert_eq!(promoted.len(),261);
        assert_eq!(promoted.last().unwrap().content," fact 0 ");
        let watermark: (i64,i64) = tx.query_row("SELECT written_memory_id,updated_at FROM memory_embedding_watermarks WHERE project_path='p'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(watermark,(promoted.last().unwrap().memory_id,100));
        assert!(promote_facts_tx(tx,"p",&facts,200)?.is_empty());
        let unchanged: (i64,i64) = tx.query_row("SELECT written_memory_id,updated_at FROM memory_embedding_watermarks WHERE project_path='p'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(unchanged,watermark);
        // Archived duplicates remain eligible for promotion; other projects do not dedup.
        tx.execute("UPDATE memories SET status='archived' WHERE content='fact 0'",[])?;
        assert_eq!(promote_facts_tx(tx,"p",&facts[..1],300)?.len(),1);
        assert_eq!(promote_facts_tx(tx,"other",&facts[..1],300)?.len(),1);
        Ok(())
    }).unwrap();
}

#[test]
fn fold_upsert_and_replace_preserve_retained_row_ids_and_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let rows: Vec<_> = (1..=10)
        .map(|i| StoredCompartment {
            sequence: i,
            start_message: i * 20,
            end_message: i * 20 + 19,
            start_message_id: format!("m{}#0", i * 20),
            end_message_id: format!("m{}#0", i * 20 + 19),
            content: format!("summary {i}"),
            p1: Some(format!("full tier {i}")),
            importance: 50,
            created_at: i,
            ..Default::default()
        })
        .collect();
    store.replace_compartments("s", &rows).unwrap();
    let read = || {
        store.context_read(|conn| {
        conn.prepare("SELECT id,sequence,content,p1 FROM compartments WHERE session_id='s' ORDER BY sequence")?
            .query_map([], |r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
    }).unwrap()
    };
    let before = read();
    let mut changed = rows[9].clone();
    changed.content = "revised summary".into();
    let mut appended = changed.clone();
    appended.sequence = 11;
    appended.start_message = 220;
    appended.end_message = 239;
    let fold = context_writes::PendingContextWrite::Fold(context_writes::FoldWrite {
        fence: None,
        lifecycle_publication_id: None,
        project_path: "p".into(),
        harness: None,
        compartments: vec![changed.clone(), appended.clone()],
        facts: Vec::new(),
        promote_facts: false,
        published_at_ms: 20,
        events: Vec::new(),
        primer_candidates: Vec::new(),
        user_memory_candidates: Vec::new(),
    });
    store
        .context_write(context_writes::HISTORY_TABLES, |tx| {
            context_writes::perf_apply_pending(tx, "s", &fold)?;
            Ok(())
        })
        .unwrap();
    let after = read();
    assert_eq!(&after[..9], &before[..9]);
    assert_eq!(after[9].0, before[9].0);
    assert_eq!(after[9].2, "revised summary");
    store
        .context_write(context_writes::HISTORY_TABLES, |tx| {
            context_writes::perf_apply_pending(tx, "s", &fold)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(read(), after);
    store
        .replace_compartments("s", &[changed, appended])
        .unwrap();
    assert_eq!(read(), after[9..]);
}

// Independent oracle: the previous oldest-first eviction algorithm, including the
// raw-only placeholder exception and repeated total queries.
fn legacy_evict(tx: &rusqlite::Transaction<'_>, session: &str) -> rusqlite::Result<()> {
    let empty = compress_transcript("").unwrap();
    loop {
        let total: i64 = tx.query_row("SELECT COALESCE(SUM(LENGTH(transcript_deflate)),0) FROM mc_chunk_transcripts WHERE session_id=?1",params![session],|r|r.get(0))?;
        if total <= MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES {
            return Ok(());
        }
        let victim: Option<(i64,bool)> = tx.query_row("SELECT compartment_seq, raw_messages_deflate IS NOT NULL FROM mc_chunk_transcripts WHERE session_id=?1 AND (raw_messages_deflate IS NULL OR transcript_deflate<>?2) ORDER BY created_at_ms,compartment_seq LIMIT 1",params![session,&empty],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((seq, raw)) = victim else {
            return Ok(());
        };
        if raw {
            tx.execute("UPDATE mc_chunk_transcripts SET transcript_deflate=?3 WHERE session_id=?1 AND compartment_seq=?2",params![session,seq,&empty])?;
        } else {
            tx.execute(
                "DELETE FROM mc_chunk_transcripts WHERE session_id=?1 AND compartment_seq=?2",
                params![session, seq],
            )?;
        }
    }
}

#[test]
fn prepared_transcripts_and_eviction_preserve_payloads_and_victim_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let transcript = "A summary with 雪 and §42§.\n";
    let raw = r#"[{"role":"user","text":"raw 雪","unknown":{"keep":true}}]"#;
    let prepared = prepare_chunk_transcripts(Some(transcript), Some(raw))
        .unwrap()
        .unwrap();
    assert_eq!(
        prepared.transcript,
        compress_transcript(transcript).unwrap()
    );
    assert_eq!(
        prepared.raw_messages.as_ref().unwrap(),
        &compress_raw_messages(raw).unwrap()
    );
    assert_eq!(
        decompress_raw_messages(prepared.raw_messages.as_ref().unwrap()).unwrap(),
        raw
    );
    let raw_only = prepare_chunk_transcripts(None, Some(raw)).unwrap().unwrap();
    assert_eq!(raw_only.transcript, compress_transcript("").unwrap());
    assert_eq!(raw_only.raw_messages, prepared.raw_messages);
    store.inner.with_conn(|conn| {
        let tx = rusqlite::Transaction::new_unchecked(conn,rusqlite::TransactionBehavior::Immediate)?;
        // Length, ordering and retention are the eviction inputs. Oversized fixture
        // blobs also exercise corrupt/legacy rows without requiring a new encoding.
        for session in ["legacy","optimized"] {
            for seq in 0..80 {
                tx.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,raw_messages_deflate,created_at_ms) VALUES (?1,?2,?2,?2,zeroblob(262144),?3,?4)",params![session,seq,if seq%3==0 {prepared.raw_messages.as_deref()}else{None},seq%5])?;
            }
            tx.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,raw_messages_deflate,created_at_ms) VALUES (?1,999,999,999,?2,?3,-1)",params![session,&raw_only.transcript,raw_only.raw_messages.as_deref()])?;
        }
        legacy_evict(&tx,"legacy")?;
        evict_chunk_transcripts_tx(&tx,"optimized")?;
        type TranscriptRows = Vec<(i64, Vec<u8>, Option<Vec<u8>>)>;
        let read = |session| -> rusqlite::Result<TranscriptRows> {
            tx.prepare("SELECT compartment_seq,transcript_deflate,raw_messages_deflate FROM mc_chunk_transcripts WHERE session_id=?1 ORDER BY compartment_seq")?
                .query_map(params![session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect()
        };
        assert_eq!(read("optimized")?,read("legacy")?);
        let raw_count: i64 = tx.query_row("SELECT COUNT(*) FROM mc_chunk_transcripts WHERE session_id='optimized' AND raw_messages_deflate IS NOT NULL",[],|r|r.get(0))?;
        assert_eq!(raw_count,28);
        tx.rollback()
    }).unwrap();
}
