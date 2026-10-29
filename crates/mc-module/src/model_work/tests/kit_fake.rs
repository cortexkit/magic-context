// Vendored from cortexkit-role-routing-conformance 0.1.0, tests/fake/mod.rs.
// Original SHA-256: ef60939ceaff9be40af1a89bbf56f3a5bb1d5acaeea71527f2ab604db8e2db6f
// Replace this copy once the kit exports its fake provider.
// Uses the same subc_protocol import as the published source.
// BEGIN VENDORED BODY
//! A reference in-process routing provider, used ONLY to test the kit.
//!
//! Conformance runs against real providers. This fake exists so the kit's
//! own tests can show that each check passes a provider that keeps the
//! contract and fails one that breaks it. The property it models:
//!
//! > A provider that reads the caller and the project from the route, never
//! > the body; refuses unknown requirements and consumers by name; answers
//! > the first catalog model that meets the request (after a pin, a project
//! > pin, or an affinity key's still-healthy previous route) on the first
//! > runner that runs it, is in `runners`, and reaches a tool provider
//! > serving every required tag; carries `reset_at_ms` on every timed
//! > refusal; binds each decision to its principal and runner; and keeps
//! > reports, admissions and observations idempotent on their keys.
//!
//! Each field of [`Defects`] breaks exactly one of those rules.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use cortexkit_role_routing_conformance::{
    wire::{
        account::{
            parse_account_for_request, Account, AccountForAnswer, AccountForRequest, AccountMode,
            AccountPin, AccountReason, AccountReasonCode, Admission,
        },
        describe::{ConsumerEntry, RoleDescribe},
        errors::{NoRouteReason, PinUnavailableReason, Refusal, RefusalCode},
        observe::{parse_account_observe_request, AccountObserveAnswer, Observation, ObserveKind},
        ops,
        report::{parse_report_request, ReportAnswer, ReportRequest},
        select::{
            parse_select_request, Requirements, RouteRef, RunnerRef, SelectAnswer,
            ToolsRequirement, REQUIREMENT_FIELDS,
        },
        wire,
    },
    Catalog, CatalogModel, CatalogRunner, ConsumerConfig, Reply, RouteFailure, RouteStamp,
    RoutingRoute, RoutingSubject,
};
use serde::Serialize;
use serde_json::Value;
use subc_protocol::ErrorBody;

/// How long a decision stays current.
const DECISION_TTL_MS: u64 = 600_000;

/// Deliberate contract breaks: each field makes the fake violate one rule a
/// check must catch.
#[derive(Clone, Copy, Debug, Default)]
pub struct Defects {
    /// role.describe states priced_only false for every consumer.
    pub describe_drops_priced_only: bool,
    /// A requirement the provider does not read is dropped, not refused.
    pub ignores_unknown_requirements: bool,
    /// A select for an unconfigured consumer is answered as if it were
    /// configured.
    pub answers_unknown_consumer: bool,
    /// `exclude` is ignored.
    pub ignores_exclude: bool,
    /// `runners` is ignored, so the answer may name a runner outside it.
    pub ignores_runners: bool,
    /// Timed refusals leave out `reset_at_ms`.
    pub drops_reset_at_ms: bool,
    /// A `project_id` member in the select body overrides the route's
    /// project.
    pub reads_scope_from_body: bool,
    /// A report on a decision is accepted from any principal.
    pub accepts_report_from_any_principal: bool,
    /// The same report body again is recorded anew, with a new answer.
    pub rerecords_repeated_report: bool,
    /// A different report body after the first replaces it instead of
    /// being refused report_conflict.
    pub overwrites_conflicting_report: bool,
    /// A failure report does not end the decision's affinity preference.
    pub affinity_survives_failure: bool,
    /// `expires_at_ms` is already in the past.
    pub expiry_in_past: bool,
    /// The same admission again is allocated anew, with a new answer.
    pub account_for_reallocates_on_replay: bool,
    /// A different body under a used admission_id is allocated instead of
    /// being refused admission_conflict.
    pub account_for_ignores_body_change: bool,
    /// A decision_id is honoured from any runner.
    pub account_for_ignores_decision_runner: bool,
    /// A decision_id is honoured for any provider and model.
    pub account_for_ignores_decision_model: bool,
    /// A repeated event_id is applied again and never answered duplicate.
    pub observe_never_duplicate: bool,
    /// Tool capability tags are matched against tool provider module names.
    pub tools_matched_by_module_name: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

struct Decision {
    principal: String,
    route: RouteRef,
    runner: String,
}

struct AffinityEntry {
    decision_id: String,
    /// A failure report on the decision ended the preference.
    ended: bool,
}

/// The pin a conversation holds on an account.
struct ConversationPin {
    id: String,
    generation: u64,
    account: usize,
}

#[derive(Default)]
struct State {
    consumers: Vec<ConsumerConfig>,
    catalog: Option<Catalog>,
    /// (project, consumer) to pin.
    project_pins: HashMap<(String, String), String>,
    /// Route key to the end of its cooldown.
    cooldowns: HashMap<String, u64>,
    decisions: HashMap<String, Decision>,
    /// (principal, consumer, affinity key) to its last decision.
    affinity: HashMap<(String, String, String), AffinityEntry>,
    reports: HashMap<String, (ReportRequest, ReportAnswer)>,
    /// (runner, admission id) to its first body and answer.
    admissions: HashMap<(String, String), (AccountForRequest, AccountForAnswer)>,
    conversations: HashMap<String, ConversationPin>,
    /// (runner, event id) to its observation.
    observations: HashMap<(String, String), Observation>,
    counter: u64,
}

impl State {
    fn next(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }
}

pub struct FakeSubject {
    state: Arc<Mutex<State>>,
    defects: Defects,
}

impl FakeSubject {
    pub fn new(defects: Defects) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            defects,
        }
    }
}

#[async_trait]
impl RoutingSubject for FakeSubject {
    type Route = FakeRoute;

    async fn reset(&self) -> Result<(), String> {
        *self.state.lock().unwrap() = State::default();
        Ok(())
    }

    async fn configure_consumers(&self, consumers: &[ConsumerConfig]) -> Result<(), String> {
        self.state.lock().unwrap().consumers = consumers.to_vec();
        Ok(())
    }

    async fn configure_catalog(&self, catalog: &Catalog) -> Result<(), String> {
        self.state.lock().unwrap().catalog = Some(catalog.clone());
        Ok(())
    }

    async fn pin_for_project(
        &self,
        project_id: &str,
        consumer: &str,
        pin: &str,
    ) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .project_pins
            .insert((project_id.to_owned(), consumer.to_owned()), pin.to_owned());
        Ok(())
    }

    async fn cool_down(&self, route_key: &str, until_ms: u64) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .cooldowns
            .insert(route_key.to_owned(), until_ms);
        Ok(())
    }

    async fn route(&self, stamp: &RouteStamp) -> Result<FakeRoute, String> {
        Ok(FakeRoute {
            state: Arc::clone(&self.state),
            defects: self.defects,
            stamp: stamp.clone(),
        })
    }
}

/// A route to the fake, carrying the caller and scope it was opened under.
pub struct FakeRoute {
    state: Arc<Mutex<State>>,
    defects: Defects,
    stamp: RouteStamp,
}

#[async_trait]
impl RoutingRoute for FakeRoute {
    async fn request(&self, method: &str, params: &Value) -> Result<Reply, RouteFailure> {
        let mut state = self.state.lock().unwrap();
        let answered = match method {
            ops::ROLE_DESCRIBE => self.describe(&state),
            ops::ROUTE_SELECT => self.select(&mut state, params),
            ops::ROUTE_REPORT => self.report(&mut state, params),
            ops::ROUTE_ACCOUNT_FOR => self.account_for(&mut state, params),
            ops::ROUTE_ACCOUNT_OBSERVE => self.observe(&mut state, params),
            other => Err(Refusal::invalid_request("method", format!("no op {other}"))),
        };
        Ok(match answered {
            Ok(answer) => {
                Reply::Response(String::from_utf8(wire::reply_body(&answer).unwrap()).unwrap())
            }
            Err(refusal) => Reply::Error(
                ErrorBody::new(refusal.code.as_str(), refusal.message)
                    .with_detail(Value::Object(refusal.detail)),
            ),
        })
    }
}

fn to_value<T: Serialize>(answer: T) -> Result<Value, Refusal> {
    Ok(serde_json::to_value(answer).unwrap())
}

fn meets(requirements: &Requirements, model: &CatalogModel) -> bool {
    requirements.iq <= model.iq
        && requirements
            .context_window
            .is_none_or(|floor| floor <= model.context_window)
        && requirements
            .max_output_tokens
            .is_none_or(|floor| floor <= model.max_output_tokens)
        && (requirements.tools != Some(ToolsRequirement::Required) || model.tool_calls)
        && requirements
            .modalities
            .iter()
            .flatten()
            .all(|modality| model.modalities.iter().any(|m| m == modality.as_str()))
        && (requirements.structured_output != Some(true) || model.structured_output)
}

impl FakeRoute {
    fn principal(&self) -> &str {
        &self.stamp.principal
    }

    fn catalog(state: &State) -> Catalog {
        state.catalog.clone().unwrap_or(Catalog {
            models: vec![],
            runners: vec![],
            accounts: vec![],
        })
    }

    fn describe(&self, state: &State) -> Result<Value, Refusal> {
        let consumers = state
            .consumers
            .iter()
            .map(|consumer| ConsumerEntry {
                id: consumer.id.clone(),
                priced_only: consumer.priced_only && !self.defects.describe_drops_priced_only,
            })
            .collect();
        to_value(RoleDescribe::new(consumers, true))
    }

    fn reaches(&self, runner: &CatalogRunner, tags: &[String]) -> bool {
        tags.iter().all(|tag| {
            runner.tool_providers.iter().any(|provider| {
                if self.defects.tools_matched_by_module_name {
                    &provider.module == tag
                } else {
                    provider.capabilities.contains(tag)
                }
            })
        })
    }

    fn select(&self, state: &mut State, params: &Value) -> Result<Value, Refusal> {
        let defects = self.defects;
        let mut params = params.clone();
        if defects.ignores_unknown_requirements {
            if let Some(Value::Object(requirements)) = params.get_mut("requirements") {
                requirements.retain(|key, _| REQUIREMENT_FIELDS.contains(&key.as_str()));
            }
        }
        let request = parse_select_request(&params)?;
        let consumer = match state.consumers.iter().find(|c| c.id == request.consumer) {
            Some(consumer) => consumer.clone(),
            None if defects.answers_unknown_consumer => ConsumerConfig {
                id: request.consumer.clone(),
                priced_only: false,
            },
            None => return Err(Refusal::unknown_consumer(request.consumer.clone())),
        };
        let catalog = Self::catalog(state);
        let project = match params.get("project_id").and_then(Value::as_str) {
            Some(project) if defects.reads_scope_from_body => Some(project.to_owned()),
            _ => self.stamp.project_id.clone(),
        };
        let exclude = match &request.exclude {
            Some(exclude) if !defects.ignores_exclude => exclude.clone(),
            _ => vec![],
        };
        let runners = request.runners.clone().filter(|_| !defects.ignores_runners);
        let tags = request
            .requirements
            .tool_capabilities
            .clone()
            .unwrap_or_default();
        let now = now_ms();
        let reset = |until: u64| (!defects.drops_reset_at_ms).then_some(until);
        let cooled = |key: &str| {
            state
                .cooldowns
                .get(key)
                .copied()
                .filter(|until| *until > now)
        };
        let eligible = |model: &CatalogModel| {
            (!consumer.priced_only || model.priced_per_token) && meets(&request.requirements, model)
        };
        let runner_for = |key: &str| {
            catalog
                .runners
                .iter()
                .find(|runner| {
                    runner.route_keys.iter().any(|k| k == key)
                        && runners
                            .as_ref()
                            .is_none_or(|listed| listed.contains(&runner.module))
                        && self.reaches(runner, &tags)
                })
                .map(|runner| runner.module.clone())
        };

        let pin = request.pin.clone().or_else(|| {
            project.and_then(|project| {
                state
                    .project_pins
                    .get(&(project, consumer.id.clone()))
                    .cloned()
            })
        });
        let (model, variant, runner) = if let Some(pin) = pin {
            let unavailable =
                |reason, reset_at| Err(Refusal::pin_unavailable(pin.clone(), reason, reset_at));
            let Some(route) = RouteRef::parse_pin(&pin) else {
                return unavailable(PinUnavailableReason::Invalid, None);
            };
            if !catalog.models.iter().any(|m| m.provider == route.provider) {
                return unavailable(PinUnavailableReason::UnknownProvider, None);
            }
            let key = route.route_key();
            let Some(model) = catalog.models.iter().find(|m| m.route_key() == key) else {
                return unavailable(PinUnavailableReason::UnknownModel, None);
            };
            if exclude.contains(&key) {
                return unavailable(PinUnavailableReason::Excluded, None);
            }
            if let Some(until) = cooled(&key) {
                return unavailable(PinUnavailableReason::Cooldown, reset(until));
            }
            if !eligible(model) {
                return unavailable(PinUnavailableReason::NotAvailable, None);
            }
            let Some(runner) = runner_for(&key) else {
                return unavailable(PinUnavailableReason::NotAvailable, None);
            };
            (model.clone(), route.variant, runner)
        } else {
            let mut candidates = Vec::new();
            let mut earliest: Option<u64> = None;
            let mut unreachable = false;
            for model in catalog.models.iter().filter(|m| eligible(m)) {
                let key = model.route_key();
                if exclude.contains(&key) {
                    continue;
                }
                let Some(runner) = runner_for(&key) else {
                    unreachable = true;
                    continue;
                };
                if let Some(until) = cooled(&key) {
                    earliest = Some(earliest.map_or(until, |e: u64| e.min(until)));
                    continue;
                }
                candidates.push((model.clone(), runner));
            }
            // The affinity key's previous route wins over the catalog order
            // while it is still a candidate: it meets the request and is not
            // cooling down. A failure report on it ends the preference.
            let preferred = request.affinity.as_ref().and_then(|affinity| {
                let entry = state.affinity.get(&(
                    self.principal().to_owned(),
                    consumer.id.clone(),
                    affinity.clone(),
                ))?;
                if entry.ended && !defects.affinity_survives_failure {
                    return None;
                }
                let previous = state.decisions.get(&entry.decision_id)?.route.route_key();
                candidates
                    .iter()
                    .position(|(model, _)| model.route_key() == previous)
            });
            match candidates.into_iter().nth(preferred.unwrap_or(0)) {
                Some((model, runner)) => (model, None, runner),
                None => {
                    return Err(match earliest {
                        Some(until) => {
                            Refusal::no_route(NoRouteReason::QuotaOrCooldown, reset(until))
                        }
                        None if unreachable => {
                            Refusal::no_route(NoRouteReason::MissingCapability, None)
                        }
                        None => Refusal::no_route(NoRouteReason::AllInadequate, None),
                    })
                }
            }
        };

        let decision_id = state.next("decision");
        let route = RouteRef {
            provider: model.provider.clone(),
            model: model.model.clone(),
            variant,
        };
        state.decisions.insert(
            decision_id.clone(),
            Decision {
                principal: self.principal().to_owned(),
                route: route.clone(),
                runner: runner.clone(),
            },
        );
        if let Some(affinity) = &request.affinity {
            state.affinity.insert(
                (
                    self.principal().to_owned(),
                    consumer.id.clone(),
                    affinity.clone(),
                ),
                AffinityEntry {
                    decision_id: decision_id.clone(),
                    ended: false,
                },
            );
        }
        let expires_at_ms = if defects.expiry_in_past {
            now - 1
        } else {
            now + DECISION_TTL_MS
        };
        to_value(SelectAnswer {
            decision_id,
            explanation: format!("{} meets the request on {runner}.", route.route_key()),
            runner: RunnerRef {
                module: runner,
                model: route.clone(),
                auth: None,
            },
            route,
            context_window: model.context_window,
            max_output_tokens: model.max_output_tokens,
            expires_at_ms,
            detail: (request.detail == Some(true)).then(|| serde_json::json!({"order": "catalog"})),
        })
    }

    fn report(&self, state: &mut State, params: &Value) -> Result<Value, Refusal> {
        let defects = self.defects;
        let request = parse_report_request(params)?;
        let Some(decision) = state.decisions.get(&request.decision_id) else {
            return Err(Refusal::unknown_decision());
        };
        if decision.principal != self.principal() && !defects.accepts_report_from_any_principal {
            return Err(Refusal::unknown_decision());
        }
        if let Some((first, answer)) = state.reports.get(&request.decision_id) {
            if *first == request {
                if !defects.rerecords_repeated_report {
                    return to_value(answer);
                }
            } else if !defects.overwrites_conflicting_report {
                return Err(Refusal::new(
                    RefusalCode::ReportConflict,
                    "a different report is recorded for this decision",
                ));
            }
        }
        let answer = ReportAnswer {
            decision_id: request.decision_id.clone(),
            report_id: state.next("report"),
            outcome: request.outcome.clone(),
        };
        if request.outcome.is_failure() {
            for entry in state.affinity.values_mut() {
                if entry.decision_id == request.decision_id {
                    entry.ended = true;
                }
            }
        }
        state
            .reports
            .insert(request.decision_id.clone(), (request, answer.clone()));
        to_value(answer)
    }

    fn is_runner(&self, state: &State) -> bool {
        Self::catalog(state)
            .runners
            .iter()
            .any(|runner| runner.module == self.principal())
    }

    fn account_for(&self, state: &mut State, params: &Value) -> Result<Value, Refusal> {
        let defects = self.defects;
        if !self.is_runner(state) {
            return Err(Refusal::new(
                RefusalCode::AccountNotAuthorized,
                "only runner modules call the account ops",
            ));
        }
        let request = parse_account_for_request(params)?;
        let key = (self.principal().to_owned(), request.admission_id.clone());
        if let Some((first, answer)) = state.admissions.get(&key) {
            if first.same_body(&request) {
                if !defects.account_for_reallocates_on_replay {
                    return to_value(answer);
                }
            } else if !defects.account_for_ignores_body_change {
                return Err(Refusal::new(
                    RefusalCode::AdmissionConflict,
                    "the admission id was used with a different body",
                ));
            }
        }
        if let Some(decision_id) = &request.decision_id {
            let Some(decision) = state.decisions.get(decision_id) else {
                return Err(Refusal::unknown_decision());
            };
            if decision.runner != self.principal() && !defects.account_for_ignores_decision_runner {
                return Err(Refusal::unknown_decision());
            }
            let same_model = decision.route.provider == request.provider
                && decision.route.model == request.model;
            if !same_model && !defects.account_for_ignores_decision_model {
                return Err(Refusal::unknown_decision());
            }
        }
        let catalog = Self::catalog(state);
        let usable: Vec<usize> = catalog
            .accounts
            .iter()
            .enumerate()
            .filter(|(_, account)| account.provider == request.provider)
            .filter(|(_, account)| {
                request.candidates.as_ref().is_none_or(|candidates| {
                    candidates
                        .accounts
                        .iter()
                        .any(|c| c.account_id == account.account_id)
                })
            })
            .map(|(index, _)| index)
            .collect();
        if usable.is_empty() {
            return Err(Refusal::new(
                RefusalCode::AuthRequired,
                "no usable account of this provider is signed in",
            ));
        }
        let requested = request
            .requested_account
            .as_ref()
            .and_then(|requested| requested.account_id.as_ref())
            .and_then(|id| {
                usable
                    .iter()
                    .copied()
                    .find(|index| &catalog.accounts[*index].account_id == id)
            });
        // The conversation's current pin: (id, generation, account index).
        let current: Option<(String, u64, usize)> = state
            .conversations
            .get(&request.conversation_key)
            .map(|pin| (pin.id.clone(), pin.generation, pin.account));
        let mode = request.mode();
        if mode != AccountMode::Admit {
            let expected = request
                .expected_pin
                .as_ref()
                .expect("checked by the parser");
            match &current {
                Some((id, generation, _))
                    if *id == expected.id && *generation == expected.generation => {}
                _ => {
                    return Err(Refusal::new(
                        RefusalCode::PinGenerationConflict,
                        "the pin is not at the expected generation",
                    ))
                }
            }
        }
        let (account, code) = match (&mode, &current) {
            (AccountMode::Reassign, Some((_, _, held))) => (
                usable
                    .iter()
                    .copied()
                    .find(|index| index != held)
                    .unwrap_or(usable[0]),
                AccountReasonCode::Reassigned,
            ),
            (AccountMode::Renew, Some((_, _, held))) => (*held, AccountReasonCode::Renewed),
            (_, Some((_, _, held))) if usable.contains(held) && requested.is_none() => {
                (*held, AccountReasonCode::Affinity)
            }
            _ => match requested {
                Some(index) => (index, AccountReasonCode::RequestedAccount),
                None => (usable[0], AccountReasonCode::Headroom),
            },
        };
        let code = if request.decision_id.is_some() {
            AccountReasonCode::Decision
        } else {
            code
        };
        let (pin_id, generation) = match (current, &mode) {
            (Some((id, generation, _)), AccountMode::Admit) => (id, generation),
            (Some((id, generation, _)), _) => (id, generation + 1),
            (None, _) => (state.next("pin"), 1),
        };
        state.conversations.insert(
            request.conversation_key.clone(),
            ConversationPin {
                id: pin_id.clone(),
                generation,
                account,
            },
        );
        let decision_id = match &request.decision_id {
            Some(decision_id) => decision_id.clone(),
            None => state.next("allocation"),
        };
        let now = now_ms();
        let chosen = &catalog.accounts[account];
        let answer = AccountForAnswer {
            admission: Admission {
                id: request.admission_id.clone(),
                state: "admitted".to_owned(),
            },
            account: Account {
                provider: chosen.provider.clone(),
                account_id: chosen.account_id.clone(),
                credential_id: chosen.credential_id.clone(),
                method: chosen.method.clone(),
            },
            pin: AccountPin {
                id: pin_id,
                generation,
                affinity_expires_at_ms: now + 3_600_000,
                admission_valid_until_ms: now + 600_000,
                lease_valid_until_ms: now + 300_000,
                mode,
            },
            reason: AccountReason {
                code,
                decision_id,
                policy_version: "fake-1".to_owned(),
                quota_fetched_at_ms: None,
                quota_age_band: "unknown".to_owned(),
            },
        };
        state.admissions.insert(key, (request, answer.clone()));
        to_value(answer)
    }

    fn observe(&self, state: &mut State, params: &Value) -> Result<Value, Refusal> {
        if !self.is_runner(state) {
            return Err(Refusal::new(
                RefusalCode::AccountNotAuthorized,
                "only runner modules call the account ops",
            ));
        }
        let request = parse_account_observe_request(params)?;
        let key = (self.principal().to_owned(), request.event_id.clone());
        if let Some(first) = state.observations.get(&key) {
            if !self.defects.observe_never_duplicate {
                return to_value(AccountObserveAnswer {
                    observation: Observation {
                        id: first.id.clone(),
                        duplicate: true,
                        bound: first.bound,
                        effects: vec![],
                    },
                });
            }
        }
        let bound = request.admission_id.as_ref().is_some_and(|admission| {
            state
                .admissions
                .contains_key(&(self.principal().to_owned(), admission.clone()))
        });
        let effects = if request.kind == ObserveKind::AccountLimitExhausted {
            vec!["account_fenced".to_owned()]
        } else {
            vec![]
        };
        let observation = Observation {
            id: state.next("observation"),
            duplicate: false,
            bound,
            effects,
        };
        state.observations.insert(key, observation.clone());
        to_value(AccountObserveAnswer { observation })
    }
}
