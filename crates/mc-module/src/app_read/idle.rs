//! Sessions without a live projection are inspected through the runner off the app-read thread.
//! A short-lived copy lets a window read all chunks from one runner answer.
use super::*;
use crate::client::RunnerClient;
use cortexkit_role_compaction::view::AppliedViewAnswer;

// A person is waiting for a window, unlike background runner calls. A short
// deadline is safe because head_not_ready is retryable and changes no state.
pub(crate) const RUNNER_HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);
const KEEP_FOR: std::time::Duration = std::time::Duration::from_secs(60);

pub(super) struct KeptHead {
    state: head::ReadState,
    breakdown: Value,
    used: std::time::Instant,
}

pub(crate) async fn fetch<C: RunnerClient>(
    app: &AppRead,
    client: &C,
    method: &str,
    params: Value,
) -> Result<Value, Refusal> {
    let fields = params.as_object().ok_or_else(|| invalid("params"))?;
    let key = session(fields.get("session").unwrap_or(&Value::Null))?;
    let started = std::time::Instant::now();
    let answer = tokio::time::timeout(RUNNER_HEAD_DEADLINE, client.applied_view(&key)).await;
    let runner_ms = started.elapsed().as_millis();
    let (outcome, result) = match answer {
        Err(_) => ("timed_out", Err(head::not_ready())),
        Ok(Err(_)) => ("route_failed", Err(head::not_ready())),
        Ok(Ok(answer)) if foreign(&answer) => ("foreign_view", Err(head::not_ready())),
        Ok(Ok(answer)) => {
            let outcome = if answer.view.is_some() {
                "served"
            } else {
                "no_view"
            };
            (outcome, app.runner_head(method, params, answer).await)
        }
    };
    tracing::info!(
        "ck-mc: session {}: idle context.head outcome={} runner_ms={}",
        key.session,
        outcome,
        runner_ms
    );
    result
}

fn foreign(answer: &AppliedViewAnswer) -> bool {
    answer
        .applied_by
        .as_deref()
        .is_some_and(|provider| provider != crate::MODULE_ID)
        || answer.view.is_some() && answer.applied_by.as_deref() != Some(crate::MODULE_ID)
}

impl Replica {
    pub(super) fn serve_head(
        &self,
        key: &SessionRef,
        method: &str,
        params: &Value,
        breakdown: &Value,
        state: &head::ReadState,
    ) -> Result<Value, Refusal> {
        if method == "context.head_section" {
            let request = head::SectionRequest::parse(params)?;
            return head::read_section(Some(state), request);
        }
        let result = head::read_breakdown(breakdown, Some(state))?;
        self.warn_head(key, &result);
        Ok(result)
    }

    pub(super) fn kept_head(
        &self,
        key: &SessionRef,
        method: &str,
        params: &Value,
    ) -> Option<Result<Value, Refusal>> {
        let mut kept = self.idle_heads.borrow_mut();
        let now = std::time::Instant::now();
        kept.retain(|_, head| now.duration_since(head.used) < KEEP_FOR);
        let head = kept.get_mut(key)?;
        if method == "context.head_section"
            && params["view"].as_u64() != head.state.offered.as_ref().map(|head| head.version)
        {
            return None;
        }
        head.used = now;
        Some(self.serve_head(key, method, params, &head.breakdown, &head.state))
    }

    pub(super) fn runner_head(
        &mut self,
        method: &str,
        params: &Value,
        answer: AppliedViewAnswer,
    ) -> Result<Value, Refusal> {
        let fields = params.as_object().ok_or_else(|| invalid("params"))?;
        let key = session(fields.get("session").unwrap_or(&Value::Null))?;
        self.identity(&key)?;
        self.ensure_loaded(&key)?;
        let snapshot = match self.locate(&key) {
            Ok(snapshot) => Some(snapshot),
            Err(refusal) if refusal.code == "store_unavailable" && self.known.contains(&key) => {
                None
            }
            Err(refusal) => return Err(refusal),
        };
        // Setup may have finished while the runner call was in flight. Prefer
        // that session's current projection over a now-older cold read.
        if let Some((snapshot, state)) = snapshot
            .zip(self.heads.get(&key))
            .filter(|(_, state)| state.ready)
        {
            self.idle_heads.borrow_mut().remove(&key);
            return self.serve_head(
                &key,
                method,
                params,
                snapshot.breakdown.without_summaries(),
                state,
            );
        }
        if foreign(&answer) {
            return Err(head::not_ready());
        }
        let unavailable = || {
            error(
                "store_unavailable",
                "The stored session head could not be read.",
            )
        };
        let conn = self.store.as_ref().ok_or_else(unavailable)?;
        let tx = conn.unchecked_transaction().map_err(|_| unavailable())?;
        let text: String = tx
            .query_row(
                "SELECT state FROM sessions WHERE runner=?1 AND harness=?2 AND session=?3",
                params![key.runner, key.harness, key.session],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        let mut value: Value = serde_json::from_str(&text).map_err(|_| unavailable())?;
        crate::store_text::transform(&mut value, &tx, false).map_err(|_| unavailable())?;
        let durable: crate::store::Durable =
            serde_json::from_value(value).map_err(|_| unavailable())?;
        tx.commit().map_err(|_| unavailable())?;
        let fallback = json!({"managed":{"value":durable.compaction.is_some()}});
        let breakdown =
            snapshot.map_or(&fallback, |snapshot| snapshot.breakdown.without_summaries());
        let model = durable.compaction.as_ref().map(|(_, conditions)| {
            format!("{}/{}", conditions.model.provider, conditions.model.model)
        });
        let mut state = head::ReadState {
            ready: true,
            ..Default::default()
        };
        if let Some(view) = answer.view {
            state.record(&view, durable.baseline, model.as_deref().unwrap_or(""));
            state.confirm(view.version);
        }
        let result = self.serve_head(&key, method, params, breakdown, &state);
        let mut kept = self.idle_heads.borrow_mut();
        let now = std::time::Instant::now();
        kept.retain(|_, head| now.duration_since(head.used) < KEEP_FOR);
        if !kept.contains_key(&key) && kept.len() >= 4 {
            if let Some(oldest) = kept
                .iter()
                .min_by_key(|(_, head)| head.used)
                .map(|(key, _)| key.clone())
            {
                kept.remove(&oldest);
            }
        }
        kept.insert(
            key,
            KeptHead {
                state,
                breakdown: breakdown.clone(),
                used: now,
            },
        );
        result
    }
}

#[cfg(test)]
#[path = "idle_tests.rs"]
mod tests;
