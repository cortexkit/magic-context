use rusqlite::{Connection, OptionalExtension};

pub(super) const PUBLIC_UPDATE: &str =
    "UPDATE message_history_fts SET message_ordinal = ?1 WHERE rowid = ?2";
const CONTENT_UPDATE: &str = "UPDATE message_history_fts_content SET c1 = ?1 WHERE id = ?2";

pub(super) fn is_ordinal_update(sql: &str) -> bool {
    matches!(sql, PUBLIC_UPDATE | CONTENT_UPDATE)
}

/// An UNINDEXED value lives only in the content table: changing it cannot
/// change tokens, token counts or ranking. Validate the SQL declaration and
/// physical column layout before relying on FTS5's internal-content layout.
pub(crate) fn ordinal_update(conn: &Connection) -> rusqlite::Result<&'static str> {
    let schema: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='message_history_fts' AND type='table'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let reason = match schema.as_deref().and_then(internal_columns) {
        Some(columns) => {
            let names: Vec<String> = conn.prepare("SELECT name FROM pragma_table_info('message_history_fts_content') ORDER BY cid")?
                .query_map([], |row| row.get(0))?.collect::<Result<_,_>>()?;
            let expected = std::iter::once("id".to_owned())
                .chain((0..columns).map(|i| format!("c{i}")))
                .collect::<Vec<_>>();
            if names == expected {
                tracing::info!("ck-mc move-in: FTS ordinal path=content-rowid; validated internal UNINDEXED column and content layout");
                return Ok(CONTENT_UPDATE);
            }
            "content table layout differs"
        }
        None => "FTS declaration is not the supported internal UNINDEXED layout",
    };
    tracing::info!("ck-mc move-in: FTS ordinal path=public-update; {reason}");
    Ok(PUBLIC_UPDATE)
}

fn internal_columns(sql: &str) -> Option<usize> {
    let tokens = tokens(sql)?;
    if tokens.get(..3)? != ["create", "virtual", "table"] {
        return None;
    }
    let using = tokens.iter().position(|token| token == "using")?;
    if tokens.get(using + 1)? != "fts5" || tokens.get(using + 2)? != "(" {
        return None;
    }
    let end = tokens.iter().rposition(|token| token == ")")?;
    let mut columns = Vec::new();
    for field in tokens.get(using + 3..end)?.split(|token| token == ",") {
        if field.get(1).is_some_and(|token| token == "=") {
            if matches!(
                field.first()?.as_str(),
                "content" | "contentless_delete" | "contentless_unindexed"
            ) {
                return None;
            }
        } else {
            columns.push(field);
        }
    }
    if columns.get(1)? != &["message_ordinal", "unindexed"] {
        return None;
    }
    Some(columns.len())
}

/// SQLite's declaration is tokenized rather than substring-matched: quoted
/// option values, comments and quoted identifiers may contain punctuation.
fn tokens(sql: &str) -> Option<Vec<String>> {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut at = 0;
    let mut result = Vec::new();
    while at < chars.len() {
        let ch = chars[at];
        if ch.is_whitespace() || ch == ';' {
            at += 1;
            continue;
        }
        if chars.get(at..at + 2) == Some(&['-', '-']) {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
            continue;
        }
        if chars.get(at..at + 2) == Some(&['/', '*']) {
            at += 2;
            while at + 1 < chars.len() && chars[at..at + 2] != ['*', '/'] {
                at += 1;
            }
            if at + 1 == chars.len() {
                return None;
            }
            at += 2;
            continue;
        }
        if ['\'', '"', '`', '['].contains(&ch) {
            let close = if ch == '[' { ']' } else { ch };
            let mut word = String::new();
            at += 1;
            loop {
                let ch = *chars.get(at)?;
                at += 1;
                if ch == close {
                    if close != ']' && chars.get(at) == Some(&close) {
                        word.push(close);
                        at += 1;
                    } else {
                        break;
                    }
                } else {
                    word.push(ch);
                }
            }
            result.push(word.to_ascii_lowercase());
        } else if ch.is_alphanumeric() || ch == '_' {
            let start = at;
            while chars
                .get(at)
                .is_some_and(|ch| ch.is_alphanumeric() || *ch == '_')
            {
                at += 1;
            }
            result.push(
                chars[start..at]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            );
        } else {
            result.push(ch.to_string());
            at += 1;
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_internal_unindexed_ordinal_layout_is_accepted() {
        assert_eq!(internal_columns("CREATE VIRTUAL TABLE f USING fts5(session_id UNINDEXED, \"message_ordinal\" UNINDEXED, content, tokenize='porter unicode61')"),Some(3));
        for sql in [
            "CREATE TABLE f(session_id, message_ordinal UNINDEXED)",
            "CREATE VIRTUAL TABLE f USING fts4(session_id, message_ordinal UNINDEXED)",
            "CREATE VIRTUAL TABLE f USING fts5(session_id, message_ordinal)",
            "CREATE VIRTUAL TABLE f USING fts5(message_ordinal UNINDEXED, session_id)",
            "CREATE VIRTUAL TABLE f USING fts5(session_id, message_ordinal UNINDEXED, content='')",
            "CREATE VIRTUAL TABLE f USING fts5(session_id, message_ordinal UNINDEXED, content='source')",
            "CREATE VIRTUAL TABLE f USING fts5(session_id, message_ordinal UNINDEXED, contentless_delete=1)",
        ] { assert_eq!(internal_columns(sql),None,"{sql}"); }
    }
}
