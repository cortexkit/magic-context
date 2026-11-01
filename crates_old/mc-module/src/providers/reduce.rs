//! Queue requested reductions without changing an already rendered prefix.
use super::*;

impl McHandler {
    pub(crate) async fn handle_provider_reduce(
        &self,
        channel: u16,
        requested: &[u64],
    ) -> HandlerOutcome {
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => return session_unresolved_error(),
        };
        self.async_reduce(&binding, requested)
            .await
            .unwrap_or_else(|error| error)
    }
}
