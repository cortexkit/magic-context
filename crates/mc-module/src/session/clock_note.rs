//! The clock note a pass sends ([`crate::clock_note`]).

use super::*;

impl Session {
    /// Send the clock note when this notice finds the model on a tool turn
    /// and a note is due, to a runner that renders datetime templates.
    pub(super) async fn send_clock_note_if_due<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
    ) {
        let Some(interval_ms) = settings.clock_note else {
            return;
        };
        let now_ms = crate::clock_note::now_ms();
        if !self.clock_note.due(now_ms, interval_ms) || !self.on_tool_turn() {
            return;
        }
        let Some(modes) = client.clock_note_delivery(&self.key).await else {
            return;
        };
        let Some(send_id) = self.next_reminder_id(crate::clock_note::KIND) else {
            return;
        };
        let request = SendRequest::template(
            send_id,
            &DeliveryOrder::new(modes)
                .with_dedupe_key(crate::clock_note::KIND)
                .with_template(crate::clock_note::note(now_ms)),
        );
        match client.send(&self.key, request).await {
            Ok(_) => self.clock_note.last_sent_ms = Some(now_ms),
            Err(error) if crate::clock_note::plan_lacks_template(&error) => {
                tracing::info!(
                    session = %self.key.session,
                    "ck-mc: session: the runner refused the clock note because the session's plan holds no clock template; none is sent until the next Setup"
                );
                self.clock_note.refused = true;
            }
            Err(error) => tracing::warn!(
                session = %self.key.session,
                ?error,
                "ck-mc: session: session.send of the clock note failed"
            ),
        }
    }

    /// Whether the newest message is the model's own, with a tool call whose
    /// result the next request sends for the first time. A turn-scoped system
    /// message the runner delivered after it doesn't count as newer.
    fn on_tool_turn(&self) -> bool {
        self.index
            .entries()
            .iter()
            .rev()
            .find(|entry| entry.role != cortexkit_role_compaction::read::Role::System)
            .is_some_and(|entry| {
                entry.role == cortexkit_role_compaction::read::Role::Assistant
                    && entry
                        .parts
                        .iter()
                        .any(|part| matches!(part.body, PartBody::Tool(_)))
            })
    }
}
