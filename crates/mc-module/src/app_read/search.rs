use super::*;
use crate::search::messages;

impl Replica {
    pub(super) fn search(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let query = string(p, "query")?;
        let scope = object(p.get("scope").unwrap_or(&Value::Null), &["session"])?;
        let key = session(scope.get("session").unwrap_or(&Value::Null))?;
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
            .any(|other| other.session == key.session && other != &key)
        {
            return Err(error(
                "session_ambiguous",
                "The message index has an ambiguous session id.",
            ));
        }
        let conn = self.context.as_ref().ok_or_else(unavailable)?;
        let indexed_harness: Option<String> = conn
            .query_row(
                "SELECT harness FROM message_history_index WHERE session_id=?1",
                [&key.session],
                |row| row.get(0),
            )
            .ok();
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
        let identity = version(&json!([key, query, snapshot.newest, snapshot.compartments]));
        let offset = match p.get("cursor").filter(|v| !v.is_null()) {
            None => 0,
            Some(value) => {
                let value = value.as_str().ok_or_else(|| invalid("cursor"))?;
                let (stamp, offset) = value.rsplit_once(':').ok_or_else(|| invalid("cursor"))?;
                if stamp != identity {
                    return Err(error(
                        "cursor_invalid",
                        "Search changed; restart the search.",
                    ));
                }
                offset
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n <= i64::MAX as usize - 51)
                    .ok_or_else(|| invalid("cursor"))?
            }
        };
        let hits = messages::app_page(conn, &key.session, query, offset, 51);
        let more = hits.len() > 50;
        let hits: Vec<Value> = hits.into_iter().take(50).map(|hit| {
            let at_ms: Option<i64> = conn.query_row("SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal=?2", params![key.session, hit.number], |row| row.get(0)).ok().flatten();
            let compartment = snapshot.compartments.iter().find(|c| c["first_message_ordinal"].as_i64().unwrap_or(i64::MAX) <= hit.number && c["last_message_ordinal"].as_i64().unwrap_or(-1) >= hit.number);
            json!({"session":key, "message_id":hit.message_id, "role":hit.role, "at_ms":at_ms, "snippet":hit.content, "match_ranges":match_ranges(&hit.content, query), "source":"message", "ordinal":hit.number, "score":hit.score, "compartment_id":compartment.map(|c| &c["compartment_id"]), "agent_id":null, "agent_resolution":"client", "project":null, "project_source":null, "ref":null})
        }).collect();
        let mut fields = json!({"next_cursor":if more {Some(format!("{identity}:{}", offset+50))} else {None}, "hits":hits, "complete":true, "agent_resolution":"client", "diagnostics":{"omitted_sessions":0, "project_resolution":{"status":"ok"}}, "source_status":{"message":"ok"}});
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
