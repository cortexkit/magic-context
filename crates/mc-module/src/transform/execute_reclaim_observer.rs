//! Inputs to bounded execute admission, captured before its production verdict.
//! Cache-rule tests keep their own held-pass counter and admission rule.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Inputs {
    pub summary_can_come: bool,
    pub signed_prefix_hold: bool,
    pub reclaimable_tokens: f64,
    pub usable_window: f64,
}

static INPUTS: LazyLock<Mutex<HashMap<usize, Inputs>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn record(store: usize, inputs: Inputs) {
    INPUTS.lock().unwrap().insert(store, inputs);
}

pub(crate) fn take(store: usize) -> Option<Inputs> {
    INPUTS.lock().unwrap().remove(&store)
}
