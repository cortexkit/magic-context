//! Indexed session routing. Connections belong to the caller's read snapshot;
//! a target must be resolved again on every request, not cached across moves.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "consumed by the session read operations")
)]

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subc_client_rs::HandlerOutcome;

use super::envelope;
use crate::providers::Key;

pub(crate) const ASYNC_LOOKUP: &str = "SELECT session_ref,state_json FROM mc_async_compaction WHERE session=?1 AND json_extract(conversation_key,'$[2]')=?2 LIMIT 2";
pub(crate) const STANDALONE_LOOKUP: &str = "SELECT harness FROM session_meta WHERE session_id=?1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct SessionRef {
    pub runner: String,
    pub harness: String,
    pub session: String,
}

impl SessionRef {
    pub fn parse(value: &Value, path: &str) -> Result<Self, HandlerOutcome> {
        let object = envelope::object(value, path)?;
        envelope::refuse_unknown(object, &["runner", "harness", "session"], path)?;
        let field = |name| {
            let field_path = format!("{path}.{name}");
            let value = object
                .get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| envelope::invalid_field(&field_path, "type", None))?;
            if value.is_empty() || value.len() > 256 || value.contains('\0') {
                return Err(envelope::invalid_field(&field_path, "range", Some(256)));
            }
            Ok(value.to_owned())
        };
        Ok(Self {
            runner: field("runner")?,
            harness: field("harness")?,
            session: field("session")?,
        })
    }
}

#[derive(Debug)]
pub(crate) struct LocatedSession {
    pub session: SessionRef,
    pub source: SessionSource,
}

#[derive(Debug)]
pub(crate) enum SessionSource {
    Standalone,
    Async {
        reference: String,
        namespace: String,
        resyncing: bool,
        moved_from_standalone: bool,
    },
}

impl LocatedSession {
    pub fn context_session_id(&self) -> &str {
        match &self.source {
            SessionSource::Standalone => &self.session.session,
            SessionSource::Async { namespace, .. } => namespace,
        }
    }

    /// Only held-transcript readers refuse resync; namespace reads remain usable.
    pub fn require_held_transcript(&self) -> Result<(), HandlerOutcome> {
        if matches!(
            self.source,
            SessionSource::Async {
                resyncing: true,
                ..
            }
        ) {
            Err(refusal(
                "session_resyncing",
                "The session is rebuilding its transcript.",
                Value::Null,
            ))
        } else {
            Ok(())
        }
    }
}

// Decode only routing/version fields, not the engine or held transcript. These
// names are the persisted AsyncRecord fields; Key owns namespace derivation.
#[derive(Deserialize)]
pub(crate) struct AsyncHeader {
    pub key: Key,
    pub runner_module: String,
    pub generation: u64,
    pub resync: bool,
    #[serde(default)]
    pub frozen_edits_version: Option<u64>,
    #[serde(default)]
    pub applied: Option<u64>,
}

impl AsyncHeader {
    pub fn namespace(&self) -> String {
        format!("{}:async:{}", self.key.engine_key(), self.generation)
    }
}

pub(crate) fn refusal(code: &str, message: &str, detail: Value) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: code.into(),
        message: message.into(),
        detail,
    }
}

pub(crate) fn store_error(error: impl std::fmt::Display) -> HandlerOutcome {
    refusal(
        "store_unavailable",
        &format!("The session store could not be read: {error}"),
        Value::Null,
    )
}

/// Runner never narrows the lookup: two matching conversations remain ambiguous
/// even when the caller supplies one of their runners.
pub(crate) fn locate(
    context: &Connection,
    store: &Connection,
    session: &SessionRef,
) -> Result<LocatedSession, HandlerOutcome> {
    let mut statement = store.prepare(ASYNC_LOOKUP).map_err(store_error)?;
    let candidates = statement
        .query_map([&session.session, &session.harness], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(store_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(store_error)?;
    if candidates.len() > 1 {
        return Err(refusal(
            "session_ambiguous",
            "More than one conversation matches the session.",
            Value::Null,
        ));
    }
    let standalone_harness: Option<String> = context
        .query_row(STANDALONE_LOOKUP, [&session.session], |r| r.get(0))
        .optional()
        .map_err(store_error)?;
    let standalone = standalone_harness.as_deref() == Some(&session.harness);
    let source = if let Some((reference, state)) = candidates.into_iter().next() {
        let header: AsyncHeader = serde_json::from_str(&state).map_err(store_error)?;
        if header.key.session != session.session || header.key.harness != session.harness {
            return Err(store_error("conversation key and record identity disagree"));
        }
        if header.runner_module != session.runner {
            return Err(refusal(
                "session_runner_mismatch",
                "The session belongs to another runner.",
                json!({"runner":header.runner_module}),
            ));
        }
        SessionSource::Async {
            reference,
            namespace: header.namespace(),
            resyncing: header.resync,
            moved_from_standalone: standalone,
        }
    } else if standalone {
        if session.runner != session.harness {
            return Err(refusal(
                "session_runner_mismatch",
                "A standalone session's runner must equal its harness.",
                json!({"runner":session.harness}),
            ));
        }
        SessionSource::Standalone
    } else {
        return Err(refusal(
            "session_not_found",
            "No session matches the reference.",
            Value::Null,
        ));
    };
    Ok(LocatedSession {
        session: session.clone(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    pub(crate) fn reference(runner: &str, harness: &str, session: &str) -> SessionRef {
        SessionRef {
            runner: runner.into(),
            harness: harness.into(),
            session: session.into(),
        }
    }

    fn code(result: Result<LocatedSession, HandlerOutcome>) -> String {
        match result.unwrap_err() {
            HandlerOutcome::ErrorWithDetail { code, .. } => code,
            other => panic!("unexpected refusal {other:?}"),
        }
    }

    #[test]
    fn standalone_opencode_and_pi_resolve_by_harness_and_session() {
        let db = TestStores::new();
        for harness in ["opencode", "opencode2", "pi"] {
            db.standalone(harness, harness);
            let target = locate(
                &db.context,
                &db.store,
                &reference(harness, harness, harness),
            )
            .unwrap();
            assert!(matches!(target.source, SessionSource::Standalone));
            assert_eq!(target.context_session_id(), harness);
        }
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("pi", "pi", "opencode")
            )),
            "session_not_found"
        );
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("other", "pi", "pi")
            )),
            "session_runner_mismatch"
        );
    }

    #[test]
    fn async_resolution_namespace_move_runner_and_resync() {
        let db = TestStores::new();
        let namespace = db.async_session("runner", "opencode", "s", 7, false);
        let session = reference("runner", "opencode", "s");
        let target = locate(&db.context, &db.store, &session).unwrap();
        assert_eq!(target.context_session_id(), namespace);
        assert!(target.require_held_transcript().is_ok());
        assert!(matches!(
            target.source,
            SessionSource::Async {
                moved_from_standalone: false,
                ..
            }
        ));
        db.standalone("s", "opencode");
        let target = locate(&db.context, &db.store, &session).unwrap();
        assert!(matches!(
            target.source,
            SessionSource::Async {
                moved_from_standalone: true,
                ..
            }
        ));
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("other", "opencode", "s")
            )),
            "session_runner_mismatch"
        );
        db.store_sql("UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.resync',json('true'),'$.generation',8)");
        let resync = locate(&db.context, &db.store, &session).unwrap();
        assert_eq!(
            resync.context_session_id(),
            format!("{}8", namespace.strip_suffix('7').unwrap())
        );
        assert!(
            matches!(resync.require_held_transcript(), Err(HandlerOutcome::ErrorWithDetail { code, .. }) if code == "session_resyncing")
        );
    }

    #[test]
    fn ambiguous_unknown_and_mode_two_only_references_are_refused() {
        let db = TestStores::new();
        db.async_session("runner-a", "pi", "shared", 0, false);
        db.async_session("runner-b", "pi", "shared", 0, false);
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("runner-a", "pi", "shared")
            )),
            "session_ambiguous"
        );
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("pi", "pi", "missing")
            )),
            "session_not_found"
        );
        db.context_sql("INSERT INTO host_runner_state(session_id,harness,lineage_id,ancestry_json,next_ordinal,cursor,served_through_ordinal,unserved_json) VALUES('bridge-only','opencode','lineage','[]',3,3,2,'[]')");
        assert_eq!(
            code(locate(
                &db.context,
                &db.store,
                &reference("opencode", "opencode", "bridge-only")
            )),
            "session_not_found"
        );
    }

    #[test]
    fn locator_queries_search_indexes() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        db.async_session("runner", "pi", "s", 0, false);
        TestStores::indexed(&db.store, ASYNC_LOOKUP, &[&"s", &"pi"]);
        TestStores::indexed(&db.context, STANDALONE_LOOKUP, &[&"s"]);
    }

    #[test]
    fn session_reference_validation_rejects_unknown_nested_keys_and_invalid_strings() {
        let mut value = json!({"runner":"pi","harness":"pi","session":"s"});
        assert!(SessionRef::parse(&value, "params.session").is_ok());
        value["extra"] = json!(true);
        assert!(
            matches!(SessionRef::parse(&value, "params.session"), Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) if code == "invalid_params" && detail["field"] == "params.session.extra")
        );
        value.as_object_mut().unwrap().remove("extra");
        for invalid in [
            json!(""),
            json!("\0"),
            json!("é".repeat(129)),
            json!(3),
            Value::Null,
        ] {
            value["session"] = invalid;
            assert!(SessionRef::parse(&value, "params.session").is_err());
        }
    }
}
