use super::*;
use session_class_tests::Client;

async fn send(client: &Client, runner: &str) -> Result<Reply, SummaryError> {
    let model = ModelRef::new("provider", "model");
    let child = Child {
        session: SessionRef::new(runner, "mock", "summary-child"),
        project_root: Some("/project".into()),
    };
    let how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(1),
        continuation: false,
        creates_child: true,
        keep_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
        plan: None,
        send: SendKind::TurnOne,
    };
    send_and_wait(client, &child, "first", "prompt", &how, &mut None).await
}

#[tokio::test]
async fn declaring_runner_receives_summary_temperature() {
    let client = Client::new(false);
    send(&client, "temperature-declared").await.unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0].1.runner_params["generation"]["temperature"],
        json!(TEMPERATURE)
    );
}

#[tokio::test]
async fn undeclared_temperature_is_omitted_on_the_only_send() {
    let mut client = Client::new(false);
    client.temperature = false;
    send(&client, "temperature-undeclared").await.unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    assert!(sends[0].1.runner_params["generation"]
        .get("temperature")
        .is_none());
    assert_eq!(
        sends[0].1.runner_params["generation"]["max_output_tokens"],
        json!(1000)
    );
}

#[tokio::test]
async fn refused_temperature_send_is_not_retried_without_the_member() {
    let mut client = Client::new(false);
    client.refuse_temperature = true;
    let result = send(&client, "temperature-refused").await;
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1, "a refused send must not be retried");
    assert_eq!(
        sends[0].1.runner_params["generation"]["temperature"],
        json!(TEMPERATURE)
    );
    assert!(
        matches!(result, Err(SummaryError::Failed(error)) if error.contains("generation.temperature"))
    );
}
