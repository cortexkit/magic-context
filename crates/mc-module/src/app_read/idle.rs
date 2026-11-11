//! Cold sessions are inspected through the runner only on demand. The answer
//! is not retained: an idle runner can change while ck-mc has no session worker.
use super::*;
use crate::client::RunnerClient;
use cortexkit_role_compaction::view::AppliedViewAnswer;

// A person is waiting for a window, unlike background runner calls. A short
// deadline is safe because head_not_ready is retryable and changes no state.
pub(crate) const RUNNER_HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);

pub(crate) async fn fetch<C: RunnerClient>(
    app: &AppRead,
    client: &C,
    params: Value,
) -> Result<Value, Refusal> {
    let fields = object(&params, &["session"])?;
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
            (outcome, app.runner_head(params, answer).await)
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
    pub(super) fn runner_head(
        &self,
        params: &Value,
        answer: AppliedViewAnswer,
    ) -> Result<Value, Refusal> {
        let fields = object(params, &["session"])?;
        let key = session(fields.get("session").unwrap_or(&Value::Null))?;
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
            let result = head::read(snapshot, Some(state))?;
            self.warn_head(&key, &result);
            return Ok(result);
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
        let result = head::read_breakdown(breakdown, Some(&state))?;
        self.warn_head(&key, &result);
        Ok(result)
    }
}

#[cfg(test)]
#[path = "idle_tests.rs"]
mod tests;
