export const RUST_SESSION_UPGRADE_REFUSAL =
    "Session upgrade is unavailable while Rust transform authority is active. The module owns compartment and memory state; switch authority through the documented drain flow before upgrading.";

export const RUST_PARTIAL_RECOMP_REFUSAL =
    "Partial recomp is unavailable while Rust transform authority is active. The module supports only a full-session recomp; no state was changed.";
