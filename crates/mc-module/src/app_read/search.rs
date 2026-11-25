use super::*;
use crate::search::messages::{self, AppPosition};
use rusqlite::OptionalExtension;

const PAGE_SIZE: usize = 50;

fn decode_position(payload: &str) -> Option<(AppPosition, usize)> {
    let mut fields = payload.split(',');
    let bm25 = f64::from_bits(u64::from_str_radix(fields.next()?, 16).ok()?);
    let ordinal = fields.next()?.parse().ok()?;
    let rowid = fields.next()?.parse().ok()?;
    let seen = fields.next()?.parse::<usize>().ok()?;
    (fields.next().is_none() && bm25.is_finite() && ordinal >= 0 && seen < usize::MAX - PAGE_SIZE)
        .then_some((
            AppPosition {
                bm25,
                ordinal,
                rowid,
            },
            seen,
        ))
}

impl Replica {
    pub(super) fn search(&mut self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let query = string(p, "query")?;
        let scope = object(p.get("scope").unwrap_or(&Value::Null), &["session"])?;
        let key = session(scope.get("session").unwrap_or(&Value::Null))?;
        self.identity(&key)?;
        self.ensure_loaded(&key)?;
        self.retry_summaries(&key);
        let snapshot = self.locate(&key)?;
        if let Some(sources) = p.get("sources") {
            if sources != &json!(["message"]) {
                return Err(invalid("sources"));
            }
        }
        // The shared raw index predates runner-qualified identities. Do not
        // expose another harness's rows when host ids collide in that index.
        if self
            .snapshots
            .keys()
            .chain(self.cache.checkpoints.iter())
            .any(|other| other.session == key.session && other != &key)
        {
            return Err(error(
                "session_ambiguous",
                "The message index has an ambiguous session id.",
            ));
        }
        let conn = self.context.as_ref().ok_or_else(unavailable)?;
        let tx = conn.unchecked_transaction().map_err(|_| unavailable())?;
        let read_harness = || {
            tx.query_row(
                "SELECT harness FROM message_history_index WHERE session_id=?1",
                [&key.session],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|_| unavailable())
        };
        // Pin the page's SQLite snapshot and coverage generation together.
        let mut coverage = self.message_coverage.borrow_mut();
        let indexed_harness = if let Some(index) = &self.message_index {
            let (generation, harness) = index.snapshot(read_harness);
            let harness = harness?;
            coverage.for_snapshot(generation);
            harness
        } else {
            read_harness()?
        };
        let conn = &*tx;
        if indexed_harness.as_ref().is_some_and(|h| h != &key.harness) {
            return Err(error(
                "session_ambiguous",
                "The message index belongs to another harness.",
            ));
        }
        let mixed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM message_history_source WHERE session_id=?1 AND harness<>?2)", params![key.session,key.harness], |row| row.get(0)).map_err(|_| unavailable())?;
        if mixed {
            return Err(error(
                "session_ambiguous",
                "The message index contains another harness's rows.",
            ));
        }
        let identity =
            summaries::search_identity(conn, &key, query, snapshot.newest, &snapshot.compartments)
                .map_err(|_| unavailable())?;
        let (after, seen) = match p.get("cursor").filter(|v| !v.is_null()) {
            None => (None, 0),
            Some(value) => {
                let value = value.as_str().ok_or_else(|| invalid("cursor"))?;
                let (stamp, payload) = value.rsplit_once(':').ok_or_else(|| invalid("cursor"))?;
                if stamp != identity {
                    return Err(error(
                        "cursor_invalid",
                        "Search changed; restart the search.",
                    ));
                }
                let (position, seen) = decode_position(payload).ok_or_else(|| invalid("cursor"))?;
                (Some(position), seen)
            }
        };
        // The app can show legacy rows even if the index has no record of
        // progress for this session. Narrow the search to the session's rows
        // through the rowid map only when the map is known to hold every row
        // of the session; otherwise search unscreened.
        let reach = messages::screened_reach(conn, &mut coverage, &key.session);
        let hits = messages::app_page_with_reach(
            conn,
            &key.session,
            query,
            after,
            seen,
            PAGE_SIZE + 1,
            &reach,
        );
        // A new match ahead of the cursor no longer shifts the next page.
        // The ranking score depends on the shared corpus, though: rescoring
        // may still move a hit across the boundary, making it repeat or disappear.
        let next_cursor = (hits.len() > PAGE_SIZE).then(|| {
            let (_, position) = hits[PAGE_SIZE - 1];
            format!(
                "{identity}:{:016x},{},{},{}",
                position.bm25.to_bits(),
                position.ordinal,
                position.rowid,
                seen + PAGE_SIZE
            )
        });
        let hits: Vec<Value> = hits.into_iter().take(PAGE_SIZE).map(|(hit, _)| {
            let at_ms: Option<i64> = conn.query_row("SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal=?2", params![key.session, hit.number], |row| row.get(0)).ok().flatten();
            let compartment = snapshot.compartments.iter().find(|c| c.first_message_ordinal <= hit.number && c.last_message_ordinal >= hit.number);
            json!({"session":key, "message_id":hit.message_id, "role":hit.role, "at_ms":at_ms, "snippet":hit.content, "match_ranges":match_ranges(&hit.content, query), "source":"message", "ordinal":hit.number, "score":hit.score, "compartment_id":compartment.map(|c| c.id()), "agent_id":null, "agent_resolution":"client", "project":null, "project_source":null, "ref":null})
        }).collect();
        let mut fields = json!({"next_cursor":next_cursor, "hits":hits, "complete":true, "agent_resolution":"client", "diagnostics":{"omitted_sessions":0, "project_resolution":{"status":"ok"}}, "source_status":{"message":"ok"}});
        envelope("context.search", &mut fields);
        Ok(fields)
    }
}

pub(super) fn match_ranges(text: &str, query: &str) -> Vec<[usize; 2]> {
    let terms: Vec<String> = query.split_whitespace().map(regex::escape).collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let Ok(pattern) = regex::RegexBuilder::new(&terms.join("|"))
        .case_insensitive(true)
        .build()
    else {
        return Vec::new();
    };
    pattern
        .find_iter(text)
        .map(|m| [m.start(), m.end()])
        .collect()
}
