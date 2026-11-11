use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Head, ReadPage, Role};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use std::sync::Mutex;

#[derive(Default)]
struct Client {
    reads: Mutex<Vec<ReadRequest>>,
    fail_at: Option<usize>,
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let mut reads = self.reads.lock().unwrap();
        reads.push(request.clone());
        if self.fail_at == Some(reads.len()) {
            return Err(ClientError::new("connection lost"));
        }
        let Select::Tags { tags } = request.select else {
            panic!("expected a tag read");
        };
        // Reverse each reply to distinguish reply order from input-name order.
        let entries = tags.into_iter().rev().map(entry).collect();
        Ok(ReadPage::new(entries, Head::new()))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }

    async fn send_child(
        &self,
        _: &crate::client::Child,
        _: SendRequest,
    ) -> Result<SendReply, ClientError> {
        unreachable!()
    }

    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        unreachable!()
    }
}

fn entry(tag: u64) -> Entry {
    let mut part = Part::new("p", PartBody::Text { text: "raw".into() });
    part.tag = Some(tag);
    Entry::new(tag, format!("m{tag}"), Role::Assistant, tag, vec![part])
}

async fn assert_tag_batches(count: u64, sizes: &[usize]) {
    let client = Client::default();
    let session = SessionRef::new("test", "mock", "s1");
    let tags: Vec<_> = (1..=count).collect();
    let entries = by_tags(&client, &session, tags.clone()).await.unwrap();
    let reads = client.reads.lock().unwrap();
    assert_eq!(reads.len(), sizes.len(), "request count for {count} tags");
    let mut offset = 0;
    for (read, size) in reads.iter().zip(sizes) {
        let expected = ReadRequest::new(
            Select::Tags {
                tags: tags[offset..offset + size].to_vec(),
            },
            Detail::Full,
        );
        assert_eq!(
            serde_json::to_vec(read).unwrap(),
            serde_json::to_vec(&expected).unwrap(),
            "unchanged request bytes for {count} tags at {offset}"
        );
        offset += size;
    }
    assert_eq!(offset, tags.len());
    let expected: Vec<_> = tags
        .chunks(256)
        .flat_map(|chunk| chunk.iter().rev().copied())
        .collect();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.ordinal)
            .collect::<Vec<_>>(),
        expected,
        "entries retain each reply's order, then request order"
    );
}

#[tokio::test]
async fn by_tags_zero_names_sends_no_request() {
    assert_tag_batches(0, &[]).await;
}

#[tokio::test]
async fn by_tags_one_name_keeps_request_bytes() {
    assert_tag_batches(1, &[1]).await;
}

#[tokio::test]
async fn by_tags_256_names_keeps_request_bytes() {
    assert_tag_batches(256, &[256]).await;
}

#[tokio::test]
async fn by_tags_257_names_splits_requests() {
    assert_tag_batches(257, &[256, 1]).await;
}

#[tokio::test]
async fn by_tags_1000_names_splits_requests() {
    assert_tag_batches(1000, &[256, 256, 256, 232]).await;
}

#[tokio::test]
async fn by_tags_error_on_second_of_three_requests_fails_the_read() {
    let client = Client {
        fail_at: Some(2),
        ..Default::default()
    };
    let error = by_tags(
        &client,
        &SessionRef::new("test", "mock", "s1"),
        (1..=513).collect(),
    )
    .await
    .expect_err("a successful first batch must not hide a failed second batch");
    assert_eq!(
        error,
        format!("session.read: {:?}", ClientError::new("connection lost"))
    );
    let reads = client.reads.lock().unwrap();
    assert_eq!(reads.len(), 2, "the third batch must not be sent");
    for (read, tags) in reads.iter().zip([1..=256, 257..=512]) {
        assert_eq!(
            serde_json::to_value(read).unwrap(),
            serde_json::to_value(ReadRequest::new(
                Select::Tags {
                    tags: tags.collect()
                },
                Detail::Full,
            ))
            .unwrap()
        );
    }
}
