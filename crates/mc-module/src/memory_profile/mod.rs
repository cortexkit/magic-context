//! Memory profiles: the bundled profile packages, and the choice of one
//! profile for a session. A profile names the memory
//! categories, with an id for each, that a session's new memories are
//! recorded under. It also says which of its categories a session under
//! another profile may see, which matters only to memories placed at
//! workspace level: the history head doesn't show those yet. Ported from the memory-levels card
//! (`crates/mc-module/src/memory_profile/` at `75adf757`).

mod bundled;
mod frames;
mod load;
mod render;
mod resolve;
mod schema;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) use frames::FRAMES;
pub(crate) use load::{load_chain, Package, Profile};
pub(crate) use render::render;
pub(crate) use resolve::{prompt_profile, resolve};
pub use resolve::{MemoryContext, ProfilePin};

/// The bundled software profile: the only one ck-mc installs.
#[allow(dead_code)] // For the history head's workspace-level memories, not built yet.
pub(crate) fn bundled_swe() -> Result<Profile> {
    bundled::swe()
}

/// Why a profile package or chain was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Refusal {
    pub code: String,
    pub detail: String,
}
type Result<T> = std::result::Result<T, Refusal>;
fn refuse(code: &str, detail: impl Into<String>) -> Refusal {
    Refusal {
        code: code.into(),
        detail: detail.into(),
    }
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

/// Build a regular expression. Every pattern in this module is built once and
/// kept, in a static or in the schema check's cache: a profile chain is loaded
/// and checked again on each Setup, and building a pattern allocates far more
/// than matching with it. Tests count the builds here to hold that.
fn compile_regex(pattern: &str) -> std::result::Result<regex::Regex, regex::Error> {
    #[cfg(test)]
    REGEX_BUILDS.with(|builds| builds.set(builds.get() + 1));
    regex::Regex::new(pattern)
}

#[cfg(test)]
thread_local! {
    /// How many regular expressions this thread built through `compile_regex`.
    /// Per thread, so tests running in parallel don't count each other's.
    static REGEX_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn regex_builds() -> usize {
    REGEX_BUILDS.with(std::cell::Cell::get)
}

#[cfg(test)]
mod render_tests;
#[cfg(test)]
mod tests;
