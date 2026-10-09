#[derive(Clone, Copy, Default)]
struct ReasoningBudgetScope<'a> {
    coverage: u64,
    anchor: Option<&'a str>,
}

impl ReasoningBudgetScope<'_> {
    fn visible(self, message: &CkIngressMessage) -> bool {
        self.coverage == 0
            || message.ordinal > self.coverage
            || self.anchor == Some(message.mid.as_str())
    }
}

fn reasoning_inline_pattern() -> &'static regex::Regex {
    static INLINE: OnceLock<regex::Regex> = OnceLock::new();
    INLINE.get_or_init(|| {
        regex::Regex::new(r"(?is)<(?:thinking|think)>(.*?)</(?:thinking|think)>").unwrap()
    })
}

/// Newest-first whole-step fit. Previously compartmentalised history costs nothing;
/// a retained lineage anchor still costs tokens but keeps its existing render exemption.
fn reasoning_budget_cutoff(
    req: &TransformRequest,
    tags: &BTreeMap<String, u64>,
    core: &CoreState,
    scope: ReasoningBudgetScope<'_>,
) -> u64 {
    let newest = latest_assistant_mid(&req.messages);
    let exempt = latest_assistant_reasoning_mutation_exempt_mid(&req.messages);
    let removed: HashSet<&str> = core
        .frozen_units
        .iter()
        .filter_map(|unit| {
            unit.key
                .strip_prefix("strip:reasoning_age:")
                .or_else(|| unit.key.strip_prefix("strip:reasoning_clear:"))
        })
        .collect();
    let assistants: Vec<_> = req
        .messages
        .iter()
        .filter(|message| {
            message.ck.role == "assistant" && !message.ck.meta.synthetic && scope.visible(message)
        })
        .collect();
    let route = active_turn_route_request(req);
    let is_exempt = |message: &&CkIngressMessage| {
        Some(message.mid.as_str()) == newest
            || Some(message.mid.as_str()) == exempt
            || Some(message.mid.as_str()) == scope.anchor
            || in_active_anthropic_turn(&route, message.mid.as_str())
    };
    let off_wire = |message: &CkIngressMessage| removed.contains(message.mid.as_str());
    let cost = |message: &CkIngressMessage| {
        let typed_gone = off_wire(message);
        let mut text = String::new();
        let mut inline_text = String::new();
        let mut opaque = false;
        let mut has_reasoning = false;
        let mut kept = message.ck.clone();
        if core
            .frozen_units
            .iter()
            .any(|unit| unit.key == format!("strip:merged_reasoning:{}", message.mid))
        {
            if let Some(profile) = SerializerProfile::parse(&req.serializer_profile) {
                let index = req
                    .messages
                    .iter()
                    .position(|entry| entry.mid == message.mid)
                    .unwrap_or(0);
                let first_in_run = index == 0 || req.messages[index - 1].ck.role != "assistant";
                apply_serializer_residual_to_message(
                    profile,
                    req.provider_id.as_deref(),
                    Some(message.mid.as_str()) == exempt
                        || Some(message.mid.as_str()) == scope.anchor,
                    first_in_run,
                    &mut kept,
                );
            }
        }
        for block in &kept.content {
            match &block.kind {
                ck_wire::CkKind::Reasoning {
                    text: visible,
                    signature,
                } if !typed_gone => {
                    has_reasoning = true;
                    if visible != "[cleared]" {
                        text.push_str(visible);
                    }
                    opaque |= visible.is_empty() && signature.is_some();
                }
                ck_wire::CkKind::RedactedReasoning { .. } if !typed_gone => {
                    opaque = true;
                    has_reasoning = true;
                }
                ck_wire::CkKind::Text { text: visible } => {
                    for captures in reasoning_inline_pattern().captures_iter(visible) {
                        inline_text.push_str(&captures[1]);
                    }
                }
                _ => {}
            }
        }
        let native = req.native_messages.iter().flatten().find(|native| {
            native.pointer("/info/id").and_then(Value::as_str) == Some(message.mid.as_str())
        });
        if let Some(parts) = native
            .filter(|_| !typed_gone)
            .and_then(|native| native.get("parts"))
            .and_then(Value::as_array)
        {
            opaque |= parts.iter().any(|part| {
                part.get("type").and_then(Value::as_str) == Some("reasoning")
                    && part.get("metadata").is_some()
                    && part
                        .get("text")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
            });
        }
        if !has_reasoning && !opaque && inline_text.is_empty() {
            return 0;
        }
        let reported = native
            .and_then(|native| native.pointer("/info/tokens/reasoning"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let ratio =
            crate::decision_calibration::DecisionCalibration::for_model(req.model_key.as_deref())
                .prose_ratio;
        let typed = if typed_gone || (!has_reasoning && !opaque) {
            0
        } else if reported > 0 {
            reported
        } else {
            reasoning_step_cost(
                0,
                (mc_tokenizer::estimate_tokens(&text) as f64 * ratio).ceil() as u64,
                opaque,
            )
        };
        typed.saturating_add(
            (mc_tokenizer::estimate_tokens(&inline_text) as f64 * ratio).ceil() as u64,
        )
    };
    let budget = req.keep_reasoning_tokens_effective.unwrap_or(10_000);
    let step_tags: Vec<_> = assistants
        .iter()
        // The anchor has its own render guard. It must not cap unbound models'
        // later removals; the signed-prefix walk stops at the anchor itself.
        .map(|message| {
            if scope.anchor == Some(message.mid.as_str())
                && Some(message.mid.as_str()) != newest
                && Some(message.mid.as_str()) != exempt
            {
                0
            } else {
                message_tag_number(message, tags)
            }
        })
        .collect();
    let exempt: Vec<_> = assistants.iter().map(is_exempt).collect();
    let gone: Vec<_> = assistants.iter().map(|message| off_wire(message) && !message.ck.content.iter().any(|block| matches!(&block.kind, ck_wire::CkKind::Text { text } if text.to_ascii_lowercase().contains("<think")))).collect();
    reasoning_budget_cutoff_steps(&step_tags, &exempt, &gone, budget, |index| {
        cost(assistants[index])
    })
}

fn reasoning_step_cost(reported: u64, text: u64, opaque: bool) -> u64 {
    if reported > 0 {
        reported
    } else if text > 0 {
        text
    } else if opaque {
        1_000
    } else {
        0
    }
}

fn reasoning_budget_cutoff_steps(
    tags: &[u64],
    exempt: &[bool],
    gone: &[bool],
    budget: u64,
    cost: impl Fn(usize) -> u64,
) -> u64 {
    let mut kept = 0u64;
    let mut upper = u64::MAX;
    for index in 0..tags.len() {
        if !exempt[index] {
            continue;
        }
        if !gone[index] {
            kept = kept.saturating_add(cost(index));
        }
        if tags[index] > 0 {
            upper = upper.min(tags[index] - 1);
        }
    }
    for index in (0..tags.len()).rev() {
        if exempt[index] || gone[index] {
            continue;
        }
        let tokens = cost(index);
        if kept.saturating_add(tokens) <= budget {
            kept = kept.saturating_add(tokens);
            if tags[index] > 0 {
                upper = upper.min(tags[index] - 1);
            }
            continue;
        }
        let mut tag = tags[index];
        if tag == 0 {
            tag = tags[..index]
                .iter()
                .rev()
                .copied()
                .find(|tag| *tag > 0)
                .unwrap_or(0);
        }
        return tag.min(upper);
    }
    0
}
