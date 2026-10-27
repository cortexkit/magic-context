//! Refuse reads and turns for released or partly moved sessions. Builds without
//! the agent-data feature load these gates from the journal without changing it.
use super::{load, Activity, ErrorBody, Journal, PassGuard, Step};
use crate::McHandler;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use subc_client_rs::HandlerOutcome;

#[derive(Default)]
pub(crate) struct MoveVisibility {
    pub(super) root: Mutex<Option<PathBuf>>,
    pub(super) activity: Arc<Mutex<Activity>>,
    pub(crate) stranded_sessions: Mutex<BTreeSet<String>>,
    unreadable: Mutex<bool>,
}
impl MoveVisibility {
    pub(crate) fn configure_readonly(&self, path: &Path) -> Result<(), ErrorBody> {
        let root = path
            .parent()
            .ok_or_else(|| super::storage("store has no parent"))?
            .join("agent-data");
        let mut configured = self.root.lock().expect("move root");
        if configured.as_ref() == Some(&root) {
            return Ok(());
        }
        *configured = Some(root.clone());
        let journal = match load::<Journal>(&root.join("journal.json")) {
            Ok(journal) => journal,
            Err(error) => {
                *self.unreadable.lock().expect("move journal safety") = true;
                return Err(error);
            }
        };
        self.refresh_gates(&journal);
        let mut warned = self
            .stranded_sessions
            .lock()
            .expect("stranded move warnings");
        let gates = self.activity.lock().expect("move activity");
        for cut in journal.cuts.values().filter(|c| {
            matches!(c.step, Step::Prepared | Step::Exported)
                || c.intent.as_deref() == Some(super::role::ops::PREPARE)
                || c.intent.as_deref() == Some(super::role::ops::EXPORT)
        }) {
            for identity in &cut.sessions {
                for session in std::iter::once(&identity.session).chain(identity.namespaces.iter())
                {
                    if gates.gates.contains_key(session) && warned.insert(session.clone()) {
                        tracing::warn!(session,"session is frozen by a stranded move; start an agent-data-enabled build to complete or abort the move");
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn refresh_gates(&self, journal: &Journal) {
        let mut activity = self.activity.lock().expect("move activity");
        activity.gates.clear();
        for (cut_id, cut) in &journal.cuts {
            if cut.intent.is_none()
                && !matches!(cut.step, Step::Prepared | Step::Exported | Step::Released)
            {
                continue;
            }
            let code = if cut.step == Step::Released {
                "session_moved"
            } else {
                "session_moving"
            };
            for id in &cut.sessions {
                for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                    if journal
                        .current
                        .get(session)
                        .is_some_and(|current| current != cut_id)
                        && cut.intent.is_none()
                    {
                        continue;
                    }
                    activity
                        .gates
                        .insert(session.clone(), (code.into(), cut.holder.clone()));
                }
            }
        }
    }
    pub(crate) fn enter(
        &self,
        sessions: Vec<String>,
        reason: &str,
    ) -> Result<PassGuard, HandlerOutcome> {
        if *self.unreadable.lock().expect("move journal safety") {
            return Err(HandlerOutcome::Error {
                code: "session_moving".into(),
                message: "move journal is unreadable; restore it before serving session data"
                    .into(),
            });
        }
        let mut activity = self.activity.lock().expect("move activity");
        for s in &sessions {
            if let Some((code, holder)) = activity.gates.get(s) {
                return Err(HandlerOutcome::ErrorWithDetail {
                    code: code.clone(),
                    message: format!("session {s} is not served on this Mac"),
                    detail: json!({"holder":holder}),
                });
            }
        }
        for s in &sessions {
            *activity
                .active
                .entry(s.clone())
                .or_default()
                .entry(reason.into())
                .or_default() += 1;
        }
        Ok(PassGuard {
            activity: self.activity.clone(),
            sessions,
            reason: reason.into(),
        })
    }
    pub(crate) fn request_pass(
        &self,
        handler: &McHandler,
        channel: u16,
        request: &Value,
        method: Option<&str>,
    ) -> Result<Option<PassGuard>, HandlerOutcome> {
        if matches!(method, Some("status" | "health" | "diagnostics")) {
            // These handlers read session rows only when session_id is explicit.
            return match request.get("session_id").and_then(Value::as_str) {
                Some(session) => self.enter(vec![session.into()], "diagnostics").map(Some),
                None => Ok(None),
            };
        }
        if matches!(method, Some("echo" | "role.describe")) {
            return Ok(None);
        }
        let mut sessions = BTreeSet::new();
        if let Some(binding) = handler
            .bindings
            .lock()
            .expect("route bindings")
            .get(&channel)
        {
            if !binding.session.is_empty() {
                sessions.insert(binding.session.clone());
            }
        }
        for pointer in [
            "/session_id",
            "/session",
            "/params/session",
            "/params/session_id",
            "/arguments/session_id",
        ] {
            if let Some(session) = request.pointer(pointer).and_then(Value::as_str) {
                if !session.is_empty() {
                    sessions.insert(session.into());
                }
            }
        }
        if sessions.is_empty() {
            return Ok(None);
        }
        let reason = match method {
            Some("dreamer.run_task") => "dreamer_running",
            _ => "run_active",
        };
        self.enter(sessions.into_iter().collect(), reason).map(Some)
    }
}
