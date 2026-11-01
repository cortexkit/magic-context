//! When a session may rebuild: the pass decision.
//!
//! A new view rewrites the provider's prompt cache from its first changed
//! byte, so a view is built only on a pass that may pay for that:
//! - when usage reaches the execute threshold, unless a summary is on its
//!   way, in which case everything waits and lands with that summary;
//! - when the runner reports that the cache is lost anyway, or that the next
//!   request would not fit (a ride). The rewrite is then free, or unavoidable.
//!
//! Below the threshold nothing happens, and every request is a cache hit.

use ck_contract_draft::notice::Conditions;

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// Usage, as a percentage of the usable window, at which a pass executes.
    pub execute_threshold_percentage: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            execute_threshold_percentage: 65.0,
        }
    }
}

/// The share of the usable window the newest request used, from the size
/// the model provider reported. `None` before the first request.
pub fn usage(conditions: &Conditions) -> Option<f64> {
    let usable = conditions
        .context_window
        .saturating_sub(conditions.output_reserve);
    let prompt = conditions.last_prompt_tokens?;
    (usable > 0).then(|| prompt as f64 / usable as f64)
}

/// Whether usage has reached the execute threshold.
pub fn at_execute(conditions: &Conditions, settings: &Settings) -> bool {
    usage(conditions).is_some_and(|usage| usage * 100.0 >= settings.execute_threshold_percentage)
}
