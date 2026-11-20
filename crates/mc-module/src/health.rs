//! The daemon's health report reads only state already held by this process.

use serde_json::json;
use subc_client_rs::{HealthReport, HealthStatus};

pub(crate) struct Health {
    pub(crate) context_open: bool,
    pub(crate) mode3_open: bool,
    pub(crate) session_count: Option<usize>,
    pub(crate) dreamer_enabled: bool,
    pub(crate) bus_connected: bool,
    #[cfg(feature = "memory-replica")]
    pub(crate) replica: Option<std::sync::Arc<crate::replica::health::Health>>,
}

impl Health {
    pub(crate) fn report(self) -> HealthReport {
        let mut reasons = Vec::<String>::new();
        if !self.context_open {
            reasons.push("context.db was not opened".into());
        }
        if !self.mode3_open {
            reasons.push("mode3.db was not opened".into());
        }
        if self.session_count.is_none() {
            reasons.push("session count unavailable".into());
        }

        // Store constructors check or set the exact schema versions before
        // returning a handle. The schema cannot change while ck-mc serves it.
        let metrics = json!({
            "headline": ["session_count", "bus_connected", "context_db_schema_version", "mode3_db_schema_version", "dreamer_enabled"],
            "session_count": self.session_count,
            "bus_connected": self.bus_connected,
            "context_db_schema_version": self.context_open.then_some(crate::context_db::SCHEMA_VERSION),
            "mode3_db_schema_version": self.mode3_open.then_some(crate::store::SCHEMA_VERSION),
            "dreamer_enabled": self.dreamer_enabled,
            "store": {
                "opened": self.context_open && self.mode3_open,
                "context_db_schema_version": self.context_open.then_some(crate::context_db::SCHEMA_VERSION),
                "mode3_db_schema_version": self.mode3_open.then_some(crate::store::SCHEMA_VERSION),
            },
            "sessions": {"count": self.session_count},
            "dreamer": {"enabled": self.dreamer_enabled},
            "bus": {"connected": self.bus_connected},
        });
        #[cfg(feature = "memory-replica")]
        let metrics = {
            let mut metrics = metrics;
            metrics["replica"] = replica(self.replica.as_deref(), &mut reasons);
            metrics["replica_unsent_count"] = metrics["replica"]["unsent_count"].clone();
            metrics["replica_epoch_holds"] = metrics["replica"]["epoch_holds"]["count"].clone();
            let headline = metrics["headline"].as_array_mut().expect("headline array");
            headline.push(json!("replica_unsent_count"));
            headline.push(json!("replica_epoch_holds"));
            metrics
        };

        let (status, detail) = if reasons.is_empty() {
            (HealthStatus::Ok, None)
        } else {
            (HealthStatus::Degraded, Some(reasons.join("; ")))
        };
        HealthReport {
            status,
            detail,
            metrics: Some(metrics),
        }
    }
}

#[cfg(feature = "memory-replica")]
fn replica(
    health: Option<&crate::replica::health::Health>,
    reasons: &mut Vec<String>,
) -> serde_json::Value {
    const STALE_AFTER_SECS: u64 = 10 * 60;
    const HOLD_LIMIT_MS: i64 = 60 * 60 * 1000;

    let mut age = None;
    let mut store = None;
    if let Some(health) = health {
        match health.read() {
            Ok(sample) => {
                let since = sample.as_ref().map_or(health.started, |sample| sample.at);
                if since.elapsed().as_secs() >= STALE_AFTER_SECS {
                    reasons.push("replica health snapshot is stale (no refresh for 10 min)".into());
                }
                if let Some(sample) = sample {
                    age = Some(sample.at.elapsed().as_secs());
                    match sample.store {
                        Ok(value) => store = Some(value),
                        Err(error) => {
                            reasons.push(format!("context.db replica read failed: {error}"))
                        }
                    }
                }
            }
            Err(reason) => reasons.push(reason.into()),
        }
    }
    let hold = store.and_then(|store| store.hold);
    if let Some((epoch, since)) = hold {
        if crate::memory_writes::now_ms().saturating_sub(since) > HOLD_LIMIT_MS {
            reasons.push(format!(
                "replica stream held for fleet epoch {epoch} for over an hour"
            ));
        }
    }

    json!({
        "enabled": health.is_some(),
        "sample_age_seconds": age,
        "unsent_count": store.map(|store| store.unsent_count),
        "epoch_holds": {
            "count": store.map(|_| usize::from(hold.is_some())),
            "oldest_held_at_ms": hold.map(|(_, since)| since),
            "epochs": store.map(|_| hold.map(|(epoch, _)| epoch).into_iter().collect::<Vec<_>>()),
        },
    })
}
