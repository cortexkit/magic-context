//! A worker whose reading of a huge request is twice its true size. The
//! emergency lane used to infer the fixed part of the prompt as the reading
//! less ck-mc's count of the transcript, found it far above the execute
//! ceiling, and dropped nothing: the next request did not fit the window and
//! the runner refused to send it. The lane now measures the fixed part from
//! the runner's exact surface counts, so the reading only lets it run.

use super::*;
use cortexkit_role_compaction::tokens::SurfaceTokens;
use mc_mock_runner::tokens::messages_tokens;

/// The usable window: 60,000 less 15,000 kept for the reply.
const LIMIT: u64 = 45_000;
const SYSTEM: u64 = 6_000;
const TOOLS: u64 = 15_000;
const READS: usize = 42;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reading {
    /// The provider reads the completed request at its rendered size.
    Correct,
    /// The provider reads it at twice that.
    Inflated,
}

/// What the runner would send now: its size, and which reads are still
/// whole.
#[derive(Clone, Debug)]
struct Snapshot {
    size: u64,
    full: Vec<u64>,
}

fn snapshot(host: &Host) -> Snapshot {
    let messages = host.rendered();
    let mut full = Vec::new();
    for m in &messages {
        for p in &m.parts {
            if let PartBody::Tool(tool) = &p.body {
                if tool.name == "read" && !m.wire_text(p).unwrap_or_default().contains("[dropped §")
                {
                    full.push(p.tag.expect("the read is numbered"));
                }
            }
        }
    }
    Snapshot {
        size: SYSTEM + TOOLS + messages_tokens(&messages, |_| 0),
        full,
    }
}

#[derive(Debug)]
struct RideSeen {
    before: Snapshot,
    count: Option<u64>,
}

/// The runner, with exact surface counts in every notice and the reading
/// of the completed bulk request replaced as `reading` says.
struct Bridge {
    inner: InProcess,
    reading: Reading,
    replaced: Mutex<Option<u64>>,
    rides: Mutex<Vec<RideSeen>>,
}

impl Provider for Bridge {
    async fn compaction_provides(&self) -> Result<Vec<String>, CallError> {
        self.inner.compaction_provides().await
    }

    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.inner.setup(request).await
    }

    async fn notice(&self, mut request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        request.conditions.system_tokens = Some(SurfaceTokens::new(SYSTEM, true));
        request.conditions.tools_tokens = Some(SurfaceTokens::new(TOOLS, true));
        request.token_family = Some("emergency-measured-mock".into());
        let host = self.inner.client.host().unwrap();
        // The notice that carries the bulk reads' results; an earlier one
        // carries the calls while they still run.
        let completed_bulk = host.entries().last().is_some_and(|entry| {
            entry
                .parts
                .iter()
                .filter(|p| {
                    matches!(&p.body, PartBody::Tool(t)
                        if t.name == "read" && t.output_bytes.unwrap_or(0) >= 23_000)
                })
                .count()
                == READS
        });
        let mut replaced = self.replaced.lock().unwrap();
        if completed_bulk && replaced.is_none() {
            let size = snapshot(&host).size;
            let reading = match self.reading {
                Reading::Correct => size,
                Reading::Inflated => size * 2,
            };
            request.conditions.last_prompt_tokens = Some(reading);
            *replaced = Some(reading);
        }
        // Not joined with the summarizer: a worker has none.
        self.inner
            .module()
            .notice(&self.inner.route.session, request)
            .map_err(call_error)
    }

    async fn ride(&self, mut request: RideRequest) -> Result<RideAnswer, CallError> {
        if let Some(reading) = *self.replaced.lock().unwrap() {
            request.conditions.last_prompt_tokens = Some(reading);
        }
        self.rides.lock().unwrap().push(RideSeen {
            before: snapshot(&self.inner.client.host().unwrap()),
            count: request.request_tokens,
        });
        self.inner.ride(request).await
    }

    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        self.inner.tool(name, input).await
    }

    async fn pre_user(&self, text: &str, now: u64) -> Result<UserEdit, CallError> {
        self.inner.pre_user(text, now).await
    }
}

fn fence() -> Step {
    Step::Await {
        condition: mc_mock_runner::script::AwaitCondition::NoticesProcessed,
        timeout_ms: 5_000,
    }
}

/// A read of `tokens` tokens. Every path differs, so no other lane removes
/// a repeated read.
fn read(path: String, tokens: usize) -> ToolCall {
    ToolCall::ok("read", json!({"path": path}), "z".repeat(4 * tokens))
}

async fn case(reading: Reading) {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config("worker", Kind::OpenAi, free());
    cfg.context_window = 60_000;
    cfg.output_reserve = 15_000;
    // The mock carries the system prompt and tool definitions as one
    // figure; the bridge reports both counts to ck-mc.
    cfg.system_tokens = SYSTEM + TOOLS;
    let settings = Settings {
        clock_note: None,
        ..Settings::default()
    };
    let client = HostClient::default();
    let bridge = Bridge {
        inner: InProcess {
            route: Route {
                session: cfg.session.clone(),
                project: None,
                workdir: None,
                agent_id: None,
            },
            module: Mutex::new(InProcess::new_module(
                client.clone(),
                settings.clone(),
                Some(dir.path()),
            )),
            client: client.clone(),
            settings,
            stores: Some(dir.path().into()),
            pre_user: false,
            restart_after_keep: Mutex::new(false),
        },
        reading,
        replaced: Mutex::new(None),
        rides: Mutex::new(Vec::new()),
    };
    let mut runner = Runner::start(cfg, bridge).await.unwrap();
    *client.host.lock().unwrap() = Some(runner.host().clone());

    let warm = "history ".repeat(765);
    for n in 0..4 {
        runner
            .play(&[
                user(&format!("Warm-up {n}. {warm}")),
                fence(),
                Step::Model(Turn {
                    tools: vec![read(format!("warm/{n}.rs"), 500)],
                    ..Turn::default()
                }),
                fence(),
            ])
            .await;
    }
    // One reply reads 42 files of 5,900 tokens each, far past the window.
    runner
        .play(&[
            Step::Model(Turn {
                tools: (0..READS)
                    .map(|n| read(format!("bulk/{n}.rs"), 5_900))
                    .collect(),
                ..Turn::default()
            }),
            fence(),
        ])
        .await;
    let sent_before = runner.report.requests.len();
    runner.play(&[answer(), fence()]).await;
    let sent = runner
        .report
        .requests
        .get(sent_before)
        .and_then(|request| request.usage.prompt_tokens);

    let label = format!("{reading:?}");
    let rides = runner.provider().rides.lock().unwrap();
    assert_eq!(rides.len(), 1, "{label}: the next request needs a ride");
    let ride = &rides[0];
    // The force-band notice dropped reads already: the reading only let the
    // lane run, the measured request sized it.
    assert!(
        ride.before.full.len() < READS,
        "{label}: the force pass took no bulk read: {ride:?}"
    );
    // The ride's count is the request the runner would send.
    assert_eq!(ride.count, Some(ride.before.size), "{label}");
    assert!(ride.before.size > LIMIT, "{label}");
    assert!(
        runner.report.view_refusals.is_empty(),
        "{label}: {:?}",
        runner.report.view_refusals
    );
    assert!(
        runner.report.refusals.is_empty(),
        "{label}: the next request was refused: {:?}",
        runner.report.refusals
    );
    assert!(
        sent.is_some_and(|sent| sent <= LIMIT),
        "{label}: sent {sent:?}"
    );
    assert!(snapshot(runner.host()).full.is_empty(), "{label}");
}

#[tokio::test]
async fn emergency_measured_an_inflated_reading_still_drops_and_the_next_request_fits() {
    for reading in [Reading::Correct, Reading::Inflated] {
        case(reading).await;
    }
}
