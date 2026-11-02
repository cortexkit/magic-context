//! Provider rules: what the session's current model and account allow a
//! view to do. The runner declares them, because only it knows the route and
//! the account. The provider plans within them and writes every consequence
//! into the view as explicit edits. The runner checks a view with the view
//! library and refuses it by name when it breaks a rule; it never fixes a
//! view up.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRules {
    pub signed_parts: SignedParts,
    pub history_edit_cost: EditCost,
}

/// How parts with [`crate::part::Seal::Signed`] constrain edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignedParts {
    /// No constraint.
    None,
    /// Anthropic thinking on the current families (Opus 5.5, Sonnet 5.5,
    /// Fable 5.1, Haiku 5.5). A signed part stays valid only while the
    /// history before it renders exactly as it did when the part was
    /// generated, with one allowance: earlier signed parts may be left out
    /// as an oldest contiguous run. Leaving out a part in the middle, or any
    /// other edit before it (a drop, a replace, an inserted message),
    /// invalidates it, so the view must leave it out as well.
    Bound,
}

/// What editing history that was already sent costs on this route.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditCost {
    /// The provider re-reads only from the first changed byte.
    Suffix,
    /// Any edit to sent history forces the whole prompt to be resent and
    /// written again (chained OpenAI requests).
    FullResend,
}

/// A rule a view breaks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "rule", rename_all = "snake_case")]
pub enum RuleBreak {
    /// A signed part the view keeps is no longer valid.
    SignedPartInvalid { mid: String, part: String },
}
