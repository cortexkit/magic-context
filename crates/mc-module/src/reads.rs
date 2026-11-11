//! Reading messages from the runner in full, page by page.

use cortexkit_role_compaction::read::{Detail, Entry, ReadRequest, Select, SessionRef};

use crate::client::{ClientError, RunnerClient};

/// How many bytes one page asks for at most.
const PAGE_BYTES: u64 = 1 << 20;

/// A later contract version states the runner's ceiling on names in one read:
/// 256. Split at that ceiling so runners enforcing it do not refuse the read.
const NAMED_READ_MAX: usize = 256;

/// Read any number of names in full, sequentially, retaining reply order.
/// A failed request fails the whole read rather than returning partial entries.
pub async fn named<C: RunnerClient, N: Clone>(
    client: &C,
    session: &SessionRef,
    names: Vec<N>,
    select: impl Fn(Vec<N>) -> Select,
) -> Result<Vec<Entry>, ClientError> {
    let mut entries = Vec::new();
    for chunk in names.chunks(NAMED_READ_MAX) {
        let request = ReadRequest::new(select(chunk.to_vec()), Detail::Full);
        entries.extend(client.read(session, request).await?.entries);
    }
    Ok(entries)
}

/// The messages with ordinals from `from` up to, not including, `until`,
/// oldest first. `stop` ends the read early once it returns true for the
/// messages read so far, so a caller with a budget never reads further than
/// it can use.
pub async fn full_range<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    from: u64,
    until: u64,
    mut stop: impl FnMut(&[Entry]) -> bool,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let mut after = from.checked_sub(1);
    while after.is_none_or(|ordinal| ordinal + 1 < until) {
        let request = ReadRequest::new(
            Select::After {
                after_ordinal: after,
                limit: None,
            },
            Detail::Full,
        )
        .with_max_bytes(PAGE_BYTES);
        let page = client
            .read(session, request)
            .await
            .map_err(|error| format!("session.read: {error:?}"))?;
        let more = page.next_after.is_some();
        for entry in page.entries {
            if entry.ordinal >= until {
                return Ok(entries);
            }
            after = Some(entry.ordinal);
            entries.push(entry);
        }
        if !more || stop(&entries) {
            break;
        }
    }
    Ok(entries)
}

/// The messages holding these tag numbers, in full.
pub async fn by_tags<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    tags: Vec<u64>,
) -> Result<Vec<Entry>, String> {
    named(client, session, tags, |tags| Select::Tags { tags })
        .await
        .map_err(|error| format!("session.read: {error:?}"))
}

#[cfg(test)]
#[path = "reads_tests.rs"]
mod tests;
