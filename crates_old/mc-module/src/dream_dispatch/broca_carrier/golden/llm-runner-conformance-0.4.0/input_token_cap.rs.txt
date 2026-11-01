//! Discovery-gated input-token cap cases, using provider observations rather
//! than transcript length to prove that model and tool requests did not start.

use std::{collections::BTreeSet, path::Path};

use cortexkit_role_harness::CrashDriver;
use cortexkit_role_llm_runner::{
    errors, ops,
    run::{budget_exhausted_causes as causes, BudgetExhaustedDetail, RunResult, RunStatus},
    send::SendReply,
};
use serde_json::json;

use crate::{
    cases::{Case, Session},
    drive::{
        call, decode, expect_error, expect_field, expect_ok, head, read_all, run_result,
        send_params, wait_run_end, Mint,
    },
    route::RunnerRoute,
    subject::{Capability, LlmRunnerSubject, Script, ScriptedPart, ScriptedTurn, ScriptedUsage},
};

fn measured(parts: Vec<ScriptedPart>, input: u64, read: u64, write: u64) -> ScriptedTurn {
    // Large output usage proves it is excluded from the input cap.
    ScriptedTurn::new(parts).with_usage(ScriptedUsage::new(input, read, write, 1000))
}

async fn send<S>(
    subject: &S,
    declared: &BTreeSet<Capability>,
    mint: &Mint,
    session: &mut Session<S::Route>,
    cap: Option<u64>,
) -> Result<RunResult, String>
where
    S: LlmRunnerSubject,
    S::Route: RunnerRoute,
{
    let before = head(&session.route).await?.last_run_state.map(|r| r.run_id);
    let id = mint.next("cap-send");
    let mut params = send_params(
        subject,
        &session.name,
        session.first.is_none(),
        "input cap episode",
        &id,
        None,
    );
    if let Some(limit) = cap {
        params["budget"]["max_input_tokens"] = json!(limit);
    }
    let reply: SendReply = decode(
        "session.send",
        expect_ok(
            "session.send",
            call(&session.route, ops::SESSION_SEND, params).await?,
        )?,
    )?;
    session
        .first
        .get_or_insert((id, "input cap episode".into()));
    let end = wait_run_end(subject, &session.route, declared, before.as_deref(), &reply).await?;
    let result = run_result(&session.route, &end.run_id).await?;
    if declared.contains(&Capability::RunStatus) {
        let status: RunStatus = decode(
            "run.status",
            expect_ok(
                "run.status",
                call(
                    &session.route,
                    ops::RUN_STATUS,
                    json!({"run_id":end.run_id}),
                )
                .await?,
            )?,
        )?;
        if status.state != result.state || status.detail != result.detail {
            return Err(format!(
                "run.status disagrees with run.result: {status:?} / {result:?}"
            ));
        }
    }
    Ok(result)
}

fn exhausted(result: &RunResult, limit: u64, spent: u64, cause: &str) -> Result<(), String> {
    let expected = BudgetExhaustedDetail::new(limit, spent, cause);
    if result.state != "budget_exhausted" || result.detail.as_ref() != Some(&expected) {
        return Err(format!(
            "expected budget_exhausted {expected:?}, got {result:?}"
        ));
    }
    Ok(())
}

async fn model_count<S: LlmRunnerSubject>(
    subject: &S,
    session: &str,
    expected: usize,
) -> Result<(), String> {
    let count = subject
        .model_invocations(session)
        .await
        .map_err(|e| e.to_string())?;
    if count != expected {
        return Err(format!(
            "model received {count} requests, expected {expected}"
        ));
    }
    Ok(())
}

pub async fn run<S>(case: &Case<'_, S>, name: &str) -> Result<(), String>
where
    S: LlmRunnerSubject,
    S::Route: RunnerRoute,
{
    match name {
        "input_token_cap_at_limit" => {
            let mut session = case
                .open(
                    "cap-exact",
                    Script {
                        turns: vec![
                            measured(vec![ScriptedPart::Text("exactly six".into())], 1, 2, 3),
                            measured(vec![ScriptedPart::Text("must not start".into())], 1, 0, 0),
                        ],
                    },
                )
                .await?;
            exhausted(
                &send(
                    case.subject,
                    case.declared,
                    case.mint,
                    &mut session,
                    Some(6),
                )
                .await?,
                6,
                6,
                causes::LIMIT_REACHED,
            )?;
            // A new episode omitting the cap must retain the frozen cap and sum.
            exhausted(
                &send(case.subject, case.declared, case.mint, &mut session, None).await?,
                6,
                6,
                causes::LIMIT_REACHED,
            )?;
            model_count(case.subject, &session.name, 1).await
        }
        "input_token_cap_crossing_tools" | "input_token_cap_usage_unreported" => {
            let unreported = name == "input_token_cap_usage_unreported";
            let prior = case.mint.call("cap-prior");
            let blocked = [
                case.mint.call("cap-blocked-a"),
                case.mint.call("cap-blocked-b"),
            ];
            let crossing = ScriptedTurn::new(
                blocked
                    .iter()
                    .cloned()
                    .map(ScriptedPart::ToolCall)
                    .collect(),
            );
            let crossing = if unreported {
                crossing
            } else {
                crossing.with_usage(ScriptedUsage::new(2, 3, 5, 1000))
            };
            let mut session = case
                .open(
                    "cap-crossing",
                    Script {
                        turns: vec![
                            measured(vec![ScriptedPart::ToolCall(prior.clone())], 1, 1, 1),
                            crossing,
                            measured(vec![ScriptedPart::Text("must not start".into())], 1, 0, 0),
                        ],
                    },
                )
                .await?;
            let result = send(
                case.subject,
                case.declared,
                case.mint,
                &mut session,
                Some(10),
            )
            .await?;
            exhausted(
                &result,
                10,
                if unreported { 3 } else { 13 },
                if unreported {
                    causes::USAGE_UNREPORTED
                } else {
                    causes::LIMIT_REACHED
                },
            )?;
            model_count(case.subject, &session.name, 2).await?;
            if case.subject.tool_invocations(&prior.arguments).await != 1 {
                return Err("the under-limit step's tool call did not execute once".into());
            }
            let (_, messages) = read_all(&session.route).await?;
            for tool in blocked {
                if case.subject.tool_invocations(&tool.arguments).await != 0 {
                    return Err(format!("blocked call {} was dispatched", tool.tool_call_id));
                }
                let results: Vec<_> = messages
                    .iter()
                    .filter_map(|m| {
                        case.subject
                            .not_executed_tool_result(&m.message, &tool.tool_call_id)
                    })
                    .collect();
                if results.len() != 1
                    || results[0].executed
                    || results[0].code != errors::BUDGET_EXHAUSTED
                {
                    return Err(format!("call {} lacks exactly one never-executed budget_exhausted result: {results:?}", tool.tool_call_id));
                }
            }
            if unreported {
                unreported_before_cap(case).await?;
            }
            Ok(())
        }
        "input_token_cap_raise_refused" | "input_token_cap_closed_members" => {
            let mut session = case
                .open(
                    "cap-policy",
                    Script {
                        turns: vec![
                            measured(vec![ScriptedPart::Text("first episode".into())], 1, 0, 0),
                            measured(
                                vec![ScriptedPart::Text("late capped episode".into())],
                                1,
                                0,
                                0,
                            ),
                            measured(vec![ScriptedPart::Text("must not start".into())], 1, 0, 0),
                        ],
                    },
                )
                .await?;
            // Installing a cap later must include the uncapped episode's usage.
            send(case.subject, case.declared, case.mint, &mut session, None).await?;
            send(
                case.subject,
                case.declared,
                case.mint,
                &mut session,
                Some(10),
            )
            .await?;
            let candidates = if name == "input_token_cap_raise_refused" {
                vec![(json!({"max_input_tokens":11}), "budget.max_input_tokens")]
            } else {
                vec![
                    (json!([]), "budget"),
                    (json!({"max_input_tokens":0}), "budget.max_input_tokens"),
                    (json!({"foo":1}), "budget.foo"),
                    (
                        json!({"nudges":[{"at_tool_calls":1,"text":"hint","foo":1}]}),
                        "budget.nudges[0].foo",
                    ),
                ]
            };
            let before = read_all(&session.route).await?.1;
            for (budget, field) in candidates {
                let mut params =
                    case.params(&session, "refuse", &case.mint.next("cap-refuse"), None);
                params["budget"] = budget;
                let error = expect_error(
                    "budget refusal",
                    call(&session.route, ops::SESSION_SEND, params).await?,
                )?;
                expect_field("budget refusal", &error, errors::INVALID_PARAMS, field)?;
            }
            if read_all(&session.route).await?.1 != before {
                return Err("refused budget wrote messages".into());
            }
            // Lowering to already-consumed input takes effect before any model request.
            exhausted(
                &send(
                    case.subject,
                    case.declared,
                    case.mint,
                    &mut session,
                    Some(2),
                )
                .await?,
                2,
                2,
                causes::LIMIT_REACHED,
            )?;
            model_count(case.subject, &session.name, 2).await
        }
        other => Err(format!("unknown input cap case {other}")),
    }
}

async fn unreported_before_cap<S>(case: &Case<'_, S>) -> Result<(), String>
where
    S: LlmRunnerSubject,
    S::Route: RunnerRoute,
{
    let mut session = case
        .open(
            "cap-late-unreported",
            Script {
                turns: vec![
                    measured(
                        vec![ScriptedPart::Text("measured uncapped episode".into())],
                        1,
                        1,
                        1,
                    ),
                    ScriptedTurn::new(vec![ScriptedPart::Text(
                        "unmeasured uncapped episode".into(),
                    )]),
                    measured(vec![ScriptedPart::Text("must not start".into())], 1, 0, 0),
                ],
            },
        )
        .await?;
    for _ in 0..2 {
        let result = send(case.subject, case.declared, case.mint, &mut session, None).await?;
        if result.state != "completed" {
            return Err(format!("uncapped episode failed: {result:?}"));
        }
    }
    exhausted(
        &send(
            case.subject,
            case.declared,
            case.mint,
            &mut session,
            Some(10),
        )
        .await?,
        10,
        3,
        causes::USAGE_UNREPORTED,
    )?;
    model_count(case.subject, &session.name, 2).await
}

/// Stop the runner between completed episodes, then reopen the same durable
/// root with the harness restart hook. No kill-point capability is needed.
pub async fn restart<S>(
    subject: &S,
    driver: &mut CrashDriver<'_, S>,
    work_dir: &Path,
    declared: &BTreeSet<Capability>,
    mint: &Mint,
) -> Result<(), String>
where
    S: LlmRunnerSubject,
    S::Route: RunnerRoute,
{
    let root = work_dir.join("input-token-cap-restart");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let handle = driver.spawn(&root).await.map_err(|e| e.to_string())?;
    let name;
    {
        let case = Case {
            subject,
            handle: &handle,
            declared,
            mint,
        };
        let mut session = case
            .open(
                "cap-restart",
                Script {
                    turns: vec![
                        measured(vec![ScriptedPart::Text("before restart".into())], 1, 2, 3),
                        measured(vec![ScriptedPart::Text("after restart".into())], 1, 1, 2),
                        measured(vec![ScriptedPart::Text("must not start".into())], 1, 0, 0),
                    ],
                },
            )
            .await?;
        let first = send(subject, declared, mint, &mut session, Some(10)).await?;
        if first.state != "completed" {
            return Err(format!("under-limit episode did not complete: {first:?}"));
        }
        model_count(subject, &session.name, 1).await?;
        name = session.name;
    }
    // Harness handles stop their module on drop, including all runner memory.
    drop(handle);
    let handle = subject.restart(&root).await.map_err(|e| e.to_string())?;
    let route = subject
        .session_route(&handle, &name, &subject.owner_stamp())
        .await
        .map_err(|e| e.to_string())?;
    let mut session = Session {
        name,
        route,
        first: Some((String::new(), String::new())),
    };
    exhausted(
        &send(subject, declared, mint, &mut session, None).await?,
        10,
        10,
        causes::LIMIT_REACHED,
    )?;
    exhausted(
        &send(subject, declared, mint, &mut session, None).await?,
        10,
        10,
        causes::LIMIT_REACHED,
    )?;
    model_count(subject, &session.name, 2).await
}
