//! Serializer healing profiles and the module residuals they leave behind.
//!
//! The serializer profile is the operational key for provider-specific cleanup that
//! happens before a request reaches the provider. The module only performs residual
//! work that the selected serializer does not already cover.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SerializerProfile {
    OwnedLlmRunner,
    /// The owned leg renamed (llm-runner -> broca). Identical serializer semantics
    /// to OwnedLlmRunner; a separate variant so the wire string keeps driving the
    /// render_config identity (the rename is a designed one-time HARD per session).
    /// OwnedLlmRunner is deleted once the fleet cut lands and nothing sends it.
    OwnedBroca,
    ClaudeCodeAnthropic,
    OpencodeAiSdk,
    Pi,
}

const ALL_PROFILES: [SerializerProfile; 5] = [
    SerializerProfile::OwnedLlmRunner,
    SerializerProfile::OwnedBroca,
    SerializerProfile::ClaudeCodeAnthropic,
    SerializerProfile::OpencodeAiSdk,
    SerializerProfile::Pi,
];

impl SerializerProfile {
    pub const fn wire_id(self) -> &'static str {
        match self {
            Self::OwnedLlmRunner => "owned-llmrunner",
            Self::OwnedBroca => "owned-broca",
            Self::ClaudeCodeAnthropic => "claude-code-anthropic",
            Self::OpencodeAiSdk => "opencode-aisdk",
            Self::Pi => "pi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owned-llmrunner" => Some(Self::OwnedLlmRunner),
            "owned-broca" => Some(Self::OwnedBroca),
            "claude-code-anthropic" => Some(Self::ClaudeCodeAnthropic),
            "opencode-aisdk" => Some(Self::OpencodeAiSdk),
            "pi" => Some(Self::Pi),
            _ => None,
        }
    }

    pub const fn all() -> &'static [Self] {
        &ALL_PROFILES
    }
}

impl Serialize for SerializerProfile {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.wire_id())
    }
}

impl<'de> Deserialize<'de> for SerializerProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| {
            serde::de::Error::custom(format!("unknown serializer profile {value:?}"))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealingCoverage {
    /// The serializer removes empty text and reasoning blocks before provider dispatch.
    pub drops_empty_content: bool,
    /// The serializer supplies an empty reasoning field for providers that require one.
    pub autofills_reasoning: bool,
    /// The serializer coalesces adjacent assistant messages before provider dispatch.
    pub merges_consecutive_assistants: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuirkResidual {
    /// Empty blocks can still reach a provider that rejects them, so module reductions must
    /// use non-empty placeholders rather than relying on the serializer to drop empties.
    pub requires_non_anthropic_empty_sentinels: bool,
    /// Adjacent assistants can be merged downstream, so only one reasoning block can survive
    /// a consecutive-assistant run.
    pub strips_reasoning_from_merged_assistants: bool,
}

pub const fn coverage(profile: SerializerProfile) -> HealingCoverage {
    match profile {
        SerializerProfile::OwnedLlmRunner
        | SerializerProfile::OwnedBroca
        | SerializerProfile::Pi => HealingCoverage {
            drops_empty_content: true,
            autofills_reasoning: true,
            merges_consecutive_assistants: false,
        },
        SerializerProfile::ClaudeCodeAnthropic => HealingCoverage {
            drops_empty_content: false,
            autofills_reasoning: false,
            merges_consecutive_assistants: false,
        },
        SerializerProfile::OpencodeAiSdk => HealingCoverage {
            drops_empty_content: false,
            autofills_reasoning: false,
            merges_consecutive_assistants: true,
        },
    }
}

/// The profile-default tail-reclaim capability.
///
/// Every shipping profile is a full-array consumer: the provider request is rebuilt from
/// the transformed array each pass, so prefix and tail rewrites both round-trip and the
/// profile default is true. Claude Code was historically the one verbatim-tail profile —
/// its Thalamus gateway byte-spliced the live tail, so a false default avoided phantom
/// reclaims (mutations frozen by the module that the splice never carried into the real
/// context). The peer retired that byte-splice at U0: full-array apply is now the only
/// serving path and the fail-open arm forwards the current raw request, never stale or
/// retained bytes, so Claude Code is full-array too. A fenced pass forwards strictly more
/// current content, and any tail mutation a fence skips simply reapplies on the next
/// healthy pass. Prefix folding remains available regardless of the tail setting.
pub const fn tail_reclaim(profile: SerializerProfile) -> bool {
    // Single exhaustive arm: all shipping profiles reclaim the tail. The match stays
    // exhaustive (not a wildcard) so a future profile forces an explicit decision here.
    match profile {
        SerializerProfile::ClaudeCodeAnthropic
        | SerializerProfile::OwnedLlmRunner
        | SerializerProfile::OwnedBroca
        | SerializerProfile::Pi
        | SerializerProfile::OpencodeAiSdk => true,
    }
}

pub const fn quirk_residual(profile: SerializerProfile) -> QuirkResidual {
    match profile {
        SerializerProfile::OpencodeAiSdk => QuirkResidual {
            requires_non_anthropic_empty_sentinels: true,
            strips_reasoning_from_merged_assistants: true,
        },
        SerializerProfile::OwnedLlmRunner
        | SerializerProfile::OwnedBroca
        | SerializerProfile::ClaudeCodeAnthropic
        | SerializerProfile::Pi => QuirkResidual {
            requires_non_anthropic_empty_sentinels: false,
            strips_reasoning_from_merged_assistants: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_profiles_parse_and_round_trip_wire_ids() {
        for profile in SerializerProfile::all() {
            assert_eq!(SerializerProfile::parse(profile.wire_id()), Some(*profile));
            assert_eq!(serde_json::to_value(profile).unwrap(), profile.wire_id());
        }
        assert_eq!(SerializerProfile::parse(""), None);
        assert_eq!(SerializerProfile::parse("unknown"), None);
    }

    #[test]
    fn owned_broca_is_semantically_identical_to_owned_llmrunner() {
        // The broca rename must not change ANY profile-derived behavior — only the
        // wire string (which drives the designed one-time render_config HARD).
        assert_eq!(
            coverage(SerializerProfile::OwnedBroca),
            coverage(SerializerProfile::OwnedLlmRunner)
        );
        assert_eq!(
            quirk_residual(SerializerProfile::OwnedBroca),
            quirk_residual(SerializerProfile::OwnedLlmRunner)
        );
        assert_eq!(
            tail_reclaim(SerializerProfile::OwnedBroca),
            tail_reclaim(SerializerProfile::OwnedLlmRunner)
        );
        assert_eq!(
            SerializerProfile::parse("owned-broca"),
            Some(SerializerProfile::OwnedBroca)
        );
        assert_eq!(SerializerProfile::OwnedBroca.wire_id(), "owned-broca");
    }

    #[test]
    fn tail_reclaim_is_full_array_for_every_shipping_profile() {
        // U0 retired the Claude Code byte-splice, so every shipping profile is now a
        // full-array consumer with tail reclaim enabled. Claude Code flips from its
        // historical false default to true; owned-broca is unchanged (it was already
        // full-array and is semantically identical to owned-llmrunner).
        for profile in SerializerProfile::all() {
            assert!(tail_reclaim(*profile), "{profile:?} must reclaim the tail");
        }
        assert!(tail_reclaim(SerializerProfile::ClaudeCodeAnthropic));
        assert!(tail_reclaim(SerializerProfile::OwnedBroca));
        assert_eq!(
            tail_reclaim(SerializerProfile::OwnedBroca),
            tail_reclaim(SerializerProfile::OwnedLlmRunner),
            "broca stays full-array, identical to llmrunner"
        );
    }

    #[test]
    fn coverage_table_is_pinned_per_serializer_profile() {
        assert_eq!(
            coverage(SerializerProfile::OwnedLlmRunner),
            HealingCoverage {
                drops_empty_content: true,
                autofills_reasoning: true,
                merges_consecutive_assistants: false,
            }
        );
        assert_eq!(
            coverage(SerializerProfile::Pi),
            coverage(SerializerProfile::OwnedLlmRunner)
        );
        assert_eq!(
            coverage(SerializerProfile::ClaudeCodeAnthropic),
            HealingCoverage {
                drops_empty_content: false,
                autofills_reasoning: false,
                merges_consecutive_assistants: false,
            }
        );
        assert_eq!(
            coverage(SerializerProfile::OpencodeAiSdk),
            HealingCoverage {
                drops_empty_content: false,
                autofills_reasoning: false,
                merges_consecutive_assistants: true,
            }
        );
    }

    #[test]
    fn residual_table_is_pinned_per_serializer_profile() {
        let empty = QuirkResidual {
            requires_non_anthropic_empty_sentinels: false,
            strips_reasoning_from_merged_assistants: false,
        };
        assert_eq!(quirk_residual(SerializerProfile::OwnedLlmRunner), empty);
        assert_eq!(quirk_residual(SerializerProfile::Pi), empty);
        assert_eq!(
            quirk_residual(SerializerProfile::ClaudeCodeAnthropic),
            empty
        );
        assert_eq!(
            quirk_residual(SerializerProfile::OpencodeAiSdk),
            QuirkResidual {
                requires_non_anthropic_empty_sentinels: true,
                strips_reasoning_from_merged_assistants: true,
            }
        );
    }
}
