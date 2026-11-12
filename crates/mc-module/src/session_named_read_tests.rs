use super::*;
use cortexkit_role_compaction::part::{Attachment, AttachmentItem, FileMedia};

#[tokio::test]
async fn ctx_reduce_batches_1000_tags_outside_the_index_and_queues_every_drop() {
    let (mut session, client, _, _, _) = fixture();
    session.index = Index::starting_at(1001);
    let entries: Vec<_> = (1..=1000).map(|n| text(n, &format!("m{n}"))).collect();
    client.pages.lock().unwrap().extend(
        entries
            .chunks(256)
            .map(|chunk| Ok(ReadPage::new(chunk.to_vec(), Head::new()))),
    );
    let answer = session
        .ctx_reduce(&client, &serde_json::json!({"drop":"1-1000"}))
        .await
        .unwrap();
    assert!(!answer.starts_with("Error:"), "{answer}");
    assert_eq!(
        session.queued,
        entries
            .iter()
            .map(|entry| (entry.mid.clone(), "p".into()))
            .collect(),
        "all 1000 archived parts must still be queued"
    );
    let reads = client.reads.lock().unwrap();
    assert_eq!(reads.len(), 4);
    for (read, chunk) in reads.iter().zip(entries.chunks(256)) {
        assert_eq!(
            serde_json::to_value(read).unwrap(),
            serde_json::to_value(ReadRequest::new(
                Select::Tags {
                    tags: chunk.iter().map(|entry| entry.ordinal).collect(),
                },
                Detail::Full,
            ))
            .unwrap()
        );
    }
}

pub(super) fn image_result(ordinal: u64) -> Entry {
    let mut part = output_part("p", ordinal);
    let PartBody::Tool(tool) = &mut part.body else {
        unreachable!()
    };
    tool.output = Some(format!("image result {ordinal}").into());
    tool.set_attachments(vec![Attachment::new(
        "image",
        AttachmentItem::File(FileMedia::inline("image/png", Some(200_000))),
    )]);
    Entry::new(
        ordinal,
        format!("m{ordinal:04}"),
        Role::Assistant,
        ordinal,
        vec![part],
    )
}

pub(super) fn hold_compact_images(session: &mut Session, entries: &[Entry]) {
    let compact = entries.iter().cloned().map(|mut entry| {
        for part in &mut entry.parts {
            if let PartBody::Tool(tool) = &mut part.body {
                tool.output = None;
            }
        }
        entry
    });
    assert_eq!(session.index.extend(compact), Extend::Continued);
    session.index_ready = true;
}

#[tokio::test]
async fn build_now_batches_image_result_mids_at_the_named_read_ceiling() {
    for (count, sizes) in [
        (0, vec![]),
        (1, vec![1]),
        (256, vec![256]),
        (257, vec![256, 1]),
        (1000, vec![256, 256, 256, 232]),
    ] {
        let (mut session, client, _, _, settings) = fixture();
        let entries: Vec<_> = (1..=count).map(image_result).collect();
        hold_compact_images(&mut session, &entries);
        *client.entries.lock().unwrap() = entries.clone();
        session.build_now(&client, &settings).await;
        let reads = client.reads.lock().unwrap();
        assert_eq!(reads.len(), sizes.len(), "request count for {count} mids");
        let mut offset = 0;
        for (read, size) in reads.iter().zip(sizes) {
            let expected = ReadRequest::new(
                Select::Mids {
                    mids: entries[offset..offset + size]
                        .iter()
                        .map(|entry| entry.mid.clone())
                        .collect(),
                },
                Detail::Full,
            );
            assert_eq!(
                serde_json::to_vec(read).unwrap(),
                serde_json::to_vec(&expected).unwrap(),
                "unchanged request bytes for {count} mids at {offset}"
            );
            offset += size;
        }
        assert_eq!(offset, entries.len());
        assert_eq!(session.image_outputs.len(), count as usize);
        for entry in entries {
            assert_eq!(
                session.image_outputs.get(&(entry.mid, "p".into())),
                Some(&format!("image result {}", entry.ordinal).into())
            );
        }
    }
}

#[tokio::test]
async fn build_now_failed_second_image_batch_does_not_cache_partial_outputs() {
    let (mut session, client, _, _, settings) = fixture();
    let entries: Vec<_> = (1..=513).map(image_result).collect();
    hold_compact_images(&mut session, &entries);
    client.pages.lock().unwrap().extend([
        Ok(ReadPage::new(entries[..256].to_vec(), Head::new())),
        Err(crate::client::ClientError::new("connection lost")),
    ]);
    session.build_now(&client, &settings).await;
    assert_eq!(client.reads.lock().unwrap().len(), 2);
    assert!(session.image_outputs.is_empty());
}
