//! Counts text composed by ck-mc in the vocabulary of the model that will read it.

use crate::calibration::{local_budget, DecisionCalibration};
use cortexkit_tokens::Family;

#[derive(Clone, Copy, Debug)]
pub struct Counter {
    family: Option<Family>,
    calibration: DecisionCalibration,
}

impl Counter {
    pub fn for_model(model_key: Option<&str>) -> Self {
        let choice = cortexkit_tokens::family_for_model(model_key.unwrap_or(""));
        let family = (choice.exact && choice.family.is_built()).then_some(choice.family);
        Self {
            family,
            calibration: if family.is_some() {
                DecisionCalibration::exact()
            } else {
                DecisionCalibration::for_model(model_key)
            },
        }
    }

    pub fn count(self, text: &str) -> u64 {
        match self.family {
            Some(family) => cortexkit_tokens::count(family, text)
                .expect("the counter only selects built vocabularies"),
            None => mc_tokenizer::estimate_tokens(text) as u64,
        }
    }

    pub fn calibration(self) -> DecisionCalibration {
        self.calibration
    }

    /// Exact counts need no conversion; estimated counts use calibration to
    /// convert the provider budget to local units.
    pub fn local_budget(self, provider_tokens: f64) -> f64 {
        if self.family.is_some() {
            return provider_tokens;
        }
        local_budget(
            provider_tokens,
            self.calibration
                .prose_ratio
                .max(self.calibration.tools_ratio),
        )
    }

    pub fn family(self) -> Option<Family> {
        self.family
    }

    #[cfg(test)]
    pub(crate) fn estimated_for_model(model_key: Option<&str>) -> Self {
        Self {
            family: None,
            calibration: DecisionCalibration::for_model(model_key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_approximate_models_keep_the_estimator() {
        for model in ["test/model", "anthropic/claude-haiku-5-5"] {
            let counter = Counter::for_model(Some(model));
            assert_eq!(counter.family(), None);
            let text = "Read src/session.rs, preserve the cached prefix, then cargo test.";
            assert_eq!(
                counter.count(text),
                mc_tokenizer::estimate_tokens(text) as u64
            );
            assert_eq!(
                counter.calibration().prose_ratio,
                DecisionCalibration::for_model(Some(model)).prose_ratio
            );
        }
    }

    #[test]
    fn opus_counts_in_its_exact_vocabulary() {
        let counter = Counter::for_model(Some("anthropic/claude-opus-5-5"));
        assert_eq!(counter.family(), Some(Family::ClaudeV5));
        assert!(counter.calibration().seeded);
        assert_eq!(counter.local_budget(1000.0), 1000.0);
        assert_eq!(
            counter.count("hello world"),
            cortexkit_tokens::count(Family::ClaudeV5, "hello world").unwrap()
        );
    }
}
