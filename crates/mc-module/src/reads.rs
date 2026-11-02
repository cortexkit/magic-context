//! Reading messages from the runner in full, page by page.

use ck_contract_draft::read::{Detail, Entry, ReadRequest, Select, SessionRef};

use crate::client::RunnerClient;

/// How many bytes one page asks for at most.
const PAGE_BYTES: u64 = 1 << 20;

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
        let request = ReadRequest {
            select: Select::After {
                after_ordinal: after,
                limit: None,
            },
            detail: Detail::Full,
            max_bytes: Some(PAGE_BYTES),
        };
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
    let request = ReadRequest {
        select: Select::Tags { tags },
        detail: Detail::Full,
        max_bytes: None,
    };
    client
        .read(session, request)
        .await
        .map(|page| page.entries)
        .map_err(|error| format!("session.read: {error:?}"))
}
