//! Runs in child sessions: what a provider starts with llm-runner's
//! `session.send` on a route bound to a child session of its own, and reads
//! with `run.result`, such as a summarizer turn.
//!
//! A run finishes at once with the reply of a scripted model. The default
//! answers a summarizer prompt the way a careful model would: one summary per
//! line of the chunk, each covering exactly that line's messages, inside the
//! `<output>` envelope the summarizer's prompt asks for. Scenarios can swap in
//! another responder, for example one that returns malformed output.

use std::collections::HashMap;
use std::sync::Arc;

use cortexkit_role_llm_runner::finish::Finish;
use cortexkit_role_llm_runner::run::{states, FinalMessage, RunError, RunResult};
use cortexkit_role_llm_runner::send::SendRequest;
use serde::Deserialize;

/// What a run runs with: the runner's own parameters of the `session.send`
/// that started it (`runner_params`), as the provider sends them, plus the
/// child session the route named.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RunSettings {
    /// The child session's id, from the route's bind identity.
    #[serde(skip)]
    pub child: String,
    pub model: RunModel,
    pub system: String,
    pub generation: Generation,
    pub stop_when: StopWhen,
    #[serde(default)]
    pub route_decision_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RunModel {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Generation {
    pub max_output_tokens: u64,
    #[serde(default)]
    pub temperature: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StopWhen {
    pub max_steps: u32,
}

/// A scripted model's reply to one run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    /// `stop`, `length` and so on, as the runner normalizes it.
    pub finish: Option<String>,
    /// The run fails with this provider error instead of replying.
    pub error: Option<String>,
}

pub type Responder = Arc<dyn Fn(&RunSettings, &str) -> Reply + Send + Sync>;

/// One run a provider started, kept for scenario assertions.
#[derive(Clone, Debug, PartialEq)]
pub struct ChildRun {
    pub child: String,
    pub prompt: String,
    pub settings: RunSettings,
    pub request: SendRequest,
    pub result: RunResult,
}

#[derive(Default)]
pub struct Runs {
    by_send_id: HashMap<String, String>,
    runs: Vec<ChildRun>,
}

impl Runs {
    /// Start a run in `child`, or return the run an earlier send with the
    /// same key started there. A refused send is answered with the field it
    /// names and why, as a runner refuses it: run parameters that don't
    /// decode, or `tools` on a send into a child that already ran. Like the
    /// live runners, the mock freezes a child's tools when its first send
    /// creates it, and refuses `tools` on every later send, even unchanged
    /// (llm-runner §9.3.1).
    pub fn start(
        &mut self,
        child: &str,
        request: SendRequest,
        responder: &Responder,
    ) -> Result<String, (&'static str, String)> {
        let key = format!("{child}\u{0}{}", request.send_id);
        if let Some(run_id) = self.by_send_id.get(&key) {
            return Ok(run_id.clone());
        }
        if request.runner_params.contains_key("tools")
            && self.runs.iter().any(|run| run.child == child)
        {
            return Err(("tools", "a child's tools are fixed by its first send".into()));
        }
        let mut settings: RunSettings =
            serde_json::from_value(serde_json::Value::Object(request.runner_params.clone()))
                .map_err(|error| ("runner_params", error.to_string()))?;
        settings.child = child.to_owned();
        settings.route_decision_id = request.route_decision_id.clone();
        let prompt = request.prompt_text().to_owned();
        let run_id = format!("run-{}", self.runs.len() + 1);
        let reply = responder(&settings, &prompt);
        self.by_send_id.insert(key, run_id.clone());
        let mut result = match &reply.error {
            Some(message) => {
                let mut result = RunResult::new(run_id.clone(), states::ERROR);
                result.error = Some(RunError::new("provider", message.clone(), "mock"));
                result
            }
            None => {
                let mut result = RunResult::new(run_id.clone(), states::COMPLETED);
                result.final_message = Some(FinalMessage {
                    ordinal: 1,
                    mid: "m1".into(),
                    text: reply.text.clone(),
                });
                result
            }
        };
        result.finish = reply.finish.as_deref().map(Finish::parse);
        self.runs.push(ChildRun {
            child: child.to_owned(),
            prompt,
            settings,
            request,
            result,
        });
        Ok(run_id)
    }

    pub fn result(&self, run_id: &str) -> Option<RunResult> {
        self.runs
            .iter()
            .find(|run| run.result.run_id == run_id)
            .map(|run| run.result.clone())
    }

    pub fn all(&self) -> &[ChildRun] {
        &self.runs
    }
}

/// What the two-pass historian's first turn asks for: its reply as a JSON
/// envelope around the summary XML.
pub const TURN_ONE_FORMAT: &str = r#"{"result":{"step":"turn_one""#;
/// What every candidate fact of a second-turn prompt starts with.
pub const TURN_TWO_FACT: &str = "## Fact ";

/// The default responder: a summarizer that covers each chunk line with one
/// summary. A first turn of the two-pass historian gets that summary in its
/// JSON envelope, and a second turn abstains on every fact. Any other prompt
/// without a `<new_messages>` chunk gets an empty reply.
pub fn scripted_summarizer() -> Responder {
    Arc::new(|_: &RunSettings, prompt: &str| {
        let text = if prompt.contains(TURN_TWO_FACT) {
            let decisions: Vec<String> = fact_ids(prompt)
                .into_iter()
                .map(|id| {
                    format!(r#"{{"fact_id":{id},"action":"abstain","check":"no memory matches"}}"#)
                })
                .collect();
            turn_two_reply(&decisions)
        } else if !prompt.contains("<new_messages>") {
            String::new()
        } else if prompt.contains(TURN_ONE_FORMAT) {
            turn_one_reply(&summarize(prompt))
        } else {
            summarize(prompt)
        };
        Reply {
            text,
            finish: Some("stop".into()),
            error: None,
        }
    })
}

/// A first-turn reply carrying `xml`.
pub fn turn_one_reply(xml: &str) -> String {
    serde_json::json!({"result": {"step": "turn_one", "xml": xml}}).to_string()
}

/// A second-turn reply with these decision objects and no scores.
pub fn turn_two_reply(decisions: &[String]) -> String {
    format!(
        r#"{{"result":{{"step":"turn_two","decisions":[{}],"scores":[]}}}}"#,
        decisions.join(",")
    )
}

/// The candidate facts of a second-turn prompt: each id with the fact's
/// text, in prompt order.
pub fn facts_of(prompt: &str) -> Vec<(i64, String)> {
    let mut facts = Vec::new();
    let mut lines = prompt.lines();
    while let Some(line) = lines.next() {
        let Some(rest) = line.strip_prefix(TURN_TWO_FACT) else {
            continue;
        };
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(id) = digits.parse() {
            facts.push((id, lines.next().unwrap_or("").to_owned()));
        }
    }
    facts
}

fn fact_ids(prompt: &str) -> Vec<i64> {
    facts_of(prompt).into_iter().map(|(id, _)| id).collect()
}

/// Summaries for every `[A]` or `[A-B]` line between `<new_messages>` and
/// `</new_messages>`.
pub fn summarize(prompt: &str) -> String {
    let body = prompt
        .split_once("<new_messages>")
        .and_then(|(_, rest)| rest.split_once("</new_messages>"))
        .map_or("", |(body, _)| body);
    let mut compartments = String::new();
    let mut last = 0;
    for line in body.lines() {
        let Some(range) = line.strip_prefix('[').and_then(|rest| rest.split_once(']')) else {
            continue;
        };
        let (start, end) = match range.0.split_once('-') {
            Some((start, end)) => (start.parse::<u64>(), end.parse::<u64>()),
            None => (range.0.parse::<u64>(), range.0.parse::<u64>()),
        };
        let (Ok(start), Ok(end)) = (start, end) else {
            continue;
        };
        last = end;
        compartments.push_str(&format!(
            "<compartment start=\"{start}\" end=\"{end}\" title=\"Messages {start}-{end}\" episode_type=\"conversation\" importance=\"50\">\n<p1>What happened in messages {start} to {end}.</p1>\n<p2>Messages {start} to {end}.</p2>\n<p3>Messages {start}-{end}.</p3>\n<p4>{start}-{end}</p4>\n</compartment>\n"
        ));
    }
    let first = body
        .lines()
        .find_map(|line| line.strip_prefix("Messages "))
        .and_then(|rest| rest.split_once('-'))
        .and_then(|(start, _)| start.parse::<u64>().ok())
        .unwrap_or(1);
    format!(
        "<output>\n<compartments>\n{compartments}</compartments>\n<meta>\n<messages_processed>{first}-{last}</messages_processed>\n<unprocessed_from>{}</unprocessed_from>\n</meta>\n</output>",
        last + 1
    )
}
