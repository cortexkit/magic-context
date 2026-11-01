//! Counts provider-reported input and cache tokens for one dreamer model session.

use serde::{Deserialize, Serialize};

pub const TOKEN_BUDGET_FINALIZE_MESSAGE: &str = "You're out of token budget. Stop investigating: make no more tool calls and output your result now, covering only what you've already checked; leave the rest out.";
pub const TOKEN_BUDGET_TOOL_REFUSAL: &str =
    "Out of token budget: no more tool calls. Output your result now.";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetAction {
    Continue,
    Finalize,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenBudget {
    pub budget: u64,
    pub spent: u64,
    pub finalize_fired: bool,
    pub refused_calls: u64,
    forced_stop: bool,
}

impl TokenBudget {
    pub fn new(budget: u64) -> Result<Self, &'static str> {
        if budget == 0 || budget > MAX_SAFE_INTEGER {
            return Err("invalid_token_budget");
        }
        Ok(Self {
            budget,
            spent: 0,
            finalize_fired: false,
            refused_calls: 0,
            forced_stop: false,
        })
    }

    pub fn hard_stopped(&self) -> bool {
        self.forced_stop || self.spent >= self.budget || self.refused_calls >= 2
    }

    pub fn finalize(&mut self) -> BudgetAction {
        if self.finalize_fired {
            return BudgetAction::Continue;
        }
        self.finalize_fired = true;
        BudgetAction::Finalize
    }

    /// Call once per provider usage report; callers deduplicate message ids.
    /// Output and reasoning tokens are deliberately absent from this interface.
    pub fn charge(
        &mut self,
        input: u64,
        cache_read: u64,
        cache_write: u64,
        completed: bool,
        can_finalize: bool,
    ) -> Result<BudgetAction, &'static str> {
        if [input, cache_read, cache_write]
            .iter()
            .any(|v| *v > MAX_SAFE_INTEGER)
        {
            return Err("invalid_prompt_usage");
        }
        let total = input
            .checked_add(cache_read)
            .and_then(|v| v.checked_add(cache_write))
            .and_then(|v| v.checked_add(self.spent))
            .ok_or("prompt_usage_overflow")?;
        self.spent = total;
        if completed {
            return Ok(BudgetAction::Continue);
        }
        if self.spent >= self.budget {
            return Ok(BudgetAction::Stop);
        }
        if !self.finalize_fired && (self.spent as f64) >= (self.budget as f64) * 0.8 {
            if !can_finalize {
                self.forced_stop = true;
                return Ok(BudgetAction::Stop);
            }
            self.finalize_fired = true;
            return Ok(BudgetAction::Finalize);
        }
        Ok(BudgetAction::Continue)
    }

    pub fn refuse_tool(&mut self) -> Option<(&'static str, bool)> {
        if !self.finalize_fired && !self.hard_stopped() {
            return None;
        }
        self.refused_calls = self.refused_calls.saturating_add(1);
        Some((TOKEN_BUDGET_TOOL_REFUSAL, self.hard_stopped()))
    }
}
