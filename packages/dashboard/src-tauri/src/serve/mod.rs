pub mod dispatch;

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::AppState;

const DEFAULT_PORT: u16 = 9077;
const DEFAULT_HOST: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;
const SUBPROCESS_CONCURRENCY_LIMIT: usize = 2;

// `blob:` is the memory-mural image. A data URL of a full-size mural can exceed
// the webview URL limit, so the page paints a blob URL with an image/png type.
// `data:` remains allowed for that fallback. This is not a file-scope widening.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServeOptions {
    pub host: IpAddr,
    pub port: u16,
    pub allow_remote: bool,
}

#[derive(Clone)]
pub struct ServeState {
    app_state: Arc<AppState>,
    token: Arc<str>,
    allowed_hosts: Arc<HashSet<String>>,
    allowed_origins: Arc<HashSet<String>>,
    wildcard_bind: bool,
    subprocess_limit: Arc<Semaphore>,
}

#[derive(Deserialize)]
struct InvokeRequest {
    cmd: String,
    #[serde(default = "empty_args")]
    args: Value,
}

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

pub fn parse_serve_args(argv: &[String]) -> Result<Option<ServeOptions>, String> {
    if !argv.iter().skip(1).any(|arg| arg == "--serve") {
        return Ok(None);
    }

    let mut host = DEFAULT_HOST;
    let mut port = DEFAULT_PORT;
    let mut explicit_port = false;
    let mut allow_remote = false;
    let mut saw_serve = false;
    let mut iter = argv.iter().skip(1).peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--serve" => {
                if saw_serve {
                    return Err("--serve may only be passed once".to_string());
                }
                saw_serve = true;
            }
            "--host" => {
                let Some(value) = iter.next() else {
                    return Err("--host requires an address".to_string());
                };
                host = parse_host(value)?;
            }
            "--allow-remote" => {
                allow_remote = true;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown serve option: {other}"));
            }
            value => {
                if !saw_serve {
                    return Err(format!("Unexpected argument before --serve: {value}"));
                }
                if explicit_port {
                    return Err(format!("Unexpected extra serve argument: {value}"));
                }
                port = parse_port(value)?;
                explicit_port = true;
            }
        }
    }

    if port == 0 {
        return Err("Serve mode requires a nonzero port".to_string());
    }
    if !host.is_loopback() && !allow_remote {
        return Err(format!(
            "Refusing to bind {host}. Serve mode exposes write access and subprocess spawning over plain bearer-token HTTP. Use SSH tunneling, or pass --allow-remote only on a trusted network."
        ));
    }

    Ok(Some(ServeOptions {
        host,
        port,
        allow_remote,
    }))
}

pub fn run(options: ServeOptions) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Failed to start async runtime: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = runtime.block_on(run_async(options)) {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

pub fn build_router(app_state: Arc<AppState>, options: &ServeOptions, token: String) -> Router {
    let allowed_hosts = allowed_hosts(options);
    let allowed_origins = allowed_origins(&allowed_hosts);
    let state = ServeState {
        app_state,
        token: Arc::from(token),
        allowed_hosts: Arc::new(allowed_hosts),
        allowed_origins: Arc::new(allowed_origins),
        wildcard_bind: options.host.is_unspecified(),
        subprocess_limit: Arc::new(Semaphore::new(SUBPROCESS_CONCURRENCY_LIMIT)),
    };

    let api = Router::new()
        .route("/invoke", post(invoke_handler))
        .route("/*path", any(api_not_found))
        .route_layer(middleware::from_fn_with_state(state.clone(), api_guard))
        // /api responses carry transcripts, config, and mutation results: never
        // let a browser (or intermediary) cache them. Static hashed assets stay
        // cacheable; only this sub-tree is marked no-store.
        .layer(middleware::from_fn(add_no_store_header))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES));

    Router::new()
        .nest("/api", api)
        .route("/", get(index_handler))
        .route("/assets/*path", get(asset_handler))
        .fallback(spa_fallback)
        .with_state(state)
        .layer(middleware::from_fn(add_security_headers))
}

async fn run_async(options: ServeOptions) -> Result<(), String> {
    let addr = SocketAddr::new(options.host, options.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|err| format!("Failed to bind {addr}: {err}"))?;
    let token = generate_token()?;
    let url = launch_url(options.host, options.port, &token);

    if options.allow_remote && !options.host.is_loopback() {
        eprintln!(
            "Warning: serve mode exposes write access and subprocess spawning over plain bearer-token HTTP. Prefer SSH tunneling for remote access."
        );
    }

    println!("Magic Context Dashboard serve mode listening on {addr}");
    println!("Open this URL: {url}");

    if has_gui_display() {
        if let Err(err) = open::that(&url) {
            eprintln!("Could not open the browser automatically: {err}");
        }
    }

    let app = build_router(Arc::new(AppState::new()), &options, token);
    axum::serve(listener, app)
        .await
        .map_err(|err| format!("Serve mode stopped: {err}"))
}

async fn invoke_handler(
    State(state): State<ServeState>,
    payload: Result<Json<InvokeRequest>, JsonRejection>,
) -> Response {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(err) => {
            let status = if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            };
            return json_error(status, format!("Invalid JSON request: {err}"));
        }
    };

    let _permit = if dispatch::uses_subprocess_or_network_probe(&payload.cmd) {
        match state.subprocess_limit.acquire().await {
            Ok(permit) => Some(permit),
            Err(_) => {
                return json_error(StatusCode::SERVICE_UNAVAILABLE, "Server is shutting down")
            }
        }
    } else {
        None
    };

    let outcome = if dispatch::uses_subprocess_or_network_probe(&payload.cmd) {
        dispatch::dispatch(&state.app_state, &payload.cmd, payload.args).await
    } else {
        // Every other command is synchronous SQLite or file work (with a 5 s
        // busy timeout), so it runs on the blocking pool: on a runtime worker
        // it would stall every other request scheduled on that worker, and a
        // few browser tabs polling at once could freeze the whole server.
        let app_state = Arc::clone(&state.app_state);
        let InvokeRequest { cmd, args } = payload;
        let handle = tokio::runtime::Handle::current();
        match tokio::task::spawn_blocking(move || {
            handle.block_on(dispatch::dispatch(&app_state, &cmd, args))
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(err) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Command failed: {err}"),
                )
            }
        }
    };

    match outcome {
        Ok(value) => Json(value).into_response(),
        Err(dispatch::DispatchError::UnknownCommand) => {
            json_error(StatusCode::NOT_FOUND, "Unknown command")
        }
        Err(dispatch::DispatchError::BadArgs(err)) => {
            json_error(StatusCode::BAD_REQUEST, format!("Invalid arguments: {err}"))
        }
        Err(dispatch::DispatchError::Command(err)) => json_error(StatusCode::BAD_REQUEST, err),
        Err(dispatch::DispatchError::Serialize(err)) => json_error(
            StatusCode::BAD_REQUEST,
            format!("Failed to encode response: {err}"),
        ),
    }
}

async fn api_not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "Unknown API route")
}

async fn api_guard(State(state): State<ServeState>, request: Request, next: Next) -> Response {
    if !host_allowed(request.headers(), &state) {
        return json_error(StatusCode::BAD_REQUEST, "Host header is not allowed");
    }
    if !origin_allowed(request.headers(), &state) {
        return json_error(StatusCode::FORBIDDEN, "Origin header is not allowed");
    }
    if !authorization_valid(request.headers(), &state.token) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid authorization token",
        );
    }
    if request.method() == Method::POST && !content_type_is_json(request.headers()) {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type must be application/json",
        );
    }
    next.run(request).await
}

async fn add_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    insert_security_headers(response.headers_mut());
    response
}

async fn add_no_store_header(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

async fn index_handler() -> Response {
    index_response()
}

async fn asset_handler(Path(path): Path<String>) -> Response {
    if path.is_empty() || path.contains("..") || path.contains('\\') || path.starts_with('/') {
        return text_response(
            StatusCode::NOT_FOUND,
            "Asset not found",
            "text/plain; charset=utf-8",
        );
    }
    let key = format!("assets/{path}");
    match Assets::get(&key) {
        Some(asset) => bytes_response(
            StatusCode::OK,
            mime_for_path(&key),
            asset.data.into_owned(),
            false,
        ),
        None => text_response(
            StatusCode::NOT_FOUND,
            "Asset not found",
            "text/plain; charset=utf-8",
        ),
    }
}

async fn spa_fallback(method: Method) -> Response {
    if method == Method::GET {
        index_response()
    } else {
        text_response(
            StatusCode::NOT_FOUND,
            "Not found",
            "text/plain; charset=utf-8",
        )
    }
}

fn index_response() -> Response {
    match Assets::get("index.html") {
        Some(asset) => bytes_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            asset.data.into_owned(),
            true,
        ),
        None => text_response(
            StatusCode::NOT_FOUND,
            "Dashboard bundle not found. Run bun run build first.",
            "text/plain; charset=utf-8",
        ),
    }
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn bytes_response(
    status: StatusCode,
    content_type: &'static str,
    body: Vec<u8>,
    no_store: bool,
) -> Response {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("response builder accepts static headers");
    if no_store {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
    }
    response
}

fn text_response(status: StatusCode, body: &'static str, content_type: &'static str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("response builder accepts static headers")
}

fn insert_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
}

fn allowed_hosts(options: &ServeOptions) -> HashSet<String> {
    let mut hosts = HashSet::from([
        format!("127.0.0.1:{}", options.port),
        format!("localhost:{}", options.port),
        format!("[::1]:{}", options.port),
    ]);
    if options.allow_remote {
        hosts.insert(format!(
            "{}:{}",
            format_host_for_header(options.host),
            options.port
        ));
    }
    hosts
}

fn allowed_origins(hosts: &HashSet<String>) -> HashSet<String> {
    hosts.iter().map(|host| format!("http://{host}")).collect()
}

fn host_allowed(headers: &HeaderMap, state: &ServeState) -> bool {
    let Some(host) = request_host(headers) else {
        return false;
    };
    if state.wildcard_bind {
        // A wildcard bind can be reached through any local interface address, so a fixed
        // Host list would reject the operator's actual LAN URL.
        return true;
    }
    state.allowed_hosts.contains(&host)
}

fn origin_allowed(headers: &HeaderMap, state: &ServeState) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(normalize_header_value)
    else {
        return true;
    };
    if state.wildcard_bind {
        let Some(host) = request_host(headers) else {
            return false;
        };
        return origin == format!("http://{host}");
    }
    state.allowed_origins.contains(&origin)
}

fn request_host(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(normalize_header_value)
        .filter(|value| !value.is_empty())
}

fn normalize_header_value(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

pub(crate) fn authorization_valid(headers: &HeaderMap, expected_token: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token.as_bytes(), expected_token.as_bytes())
}

fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in actual.iter().zip(expected.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        .unwrap_or(false)
}

fn empty_args() -> Value {
    Value::Object(Default::default())
}

fn parse_host(value: &str) -> Result<IpAddr, String> {
    if value.eq_ignore_ascii_case("localhost") {
        return Ok(DEFAULT_HOST);
    }
    value
        .parse::<IpAddr>()
        .map_err(|err| format!("Invalid host address {value}: {err}"))
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|err| format!("Invalid serve port {value}: {err}"))?;
    if port == 0 {
        return Err("Serve mode requires a nonzero port".to_string());
    }
    Ok(port)
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("Failed to generate auth token: {err}"))?;
    Ok(hex_encode(&bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn launch_url(host: IpAddr, port: u16, token: &str) -> String {
    let display_host = if host.is_unspecified() {
        "127.0.0.1".to_string()
    } else {
        format_host_for_url(host)
    };
    format!("http://{display_host}:{port}/#token={token}")
}

fn format_host_for_header(host: IpAddr) -> String {
    match host {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn format_host_for_url(host: IpAddr) -> String {
    format_host_for_header(host)
}

fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn has_gui_display() -> bool {
    true
}

#[cfg(all(unix, not(target_os = "macos")))]
fn has_gui_display() -> bool {
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(not(any(unix, target_os = "windows")))]
fn has_gui_display() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use tempfile::tempdir;
    use tokio::task::JoinHandle;

    struct TestServer {
        base_url: String,
        token: String,
        port: u16,
        handle: JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    fn state_without_db() -> AppState {
        AppState::with_resolver(|| None)
    }

    async fn spawn_test_server() -> TestServer {
        spawn_test_server_with_options(DEFAULT_HOST, false).await
    }

    async fn spawn_remote_test_server() -> TestServer {
        spawn_test_server_with_options(IpAddr::V4(Ipv4Addr::UNSPECIFIED), true).await
    }

    async fn spawn_test_server_with_options(host: IpAddr, allow_remote: bool) -> TestServer {
        spawn_test_server_with_state(state_without_db(), host, allow_remote).await
    }

    async fn spawn_test_server_with_state(
        app_state: AppState,
        host: IpAddr,
        allow_remote: bool,
    ) -> TestServer {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("test listener");
        let port = listener.local_addr().expect("local addr").port();
        let options = ServeOptions {
            host,
            port,
            allow_remote,
        };
        let token = "a".repeat(64);
        let app = build_router(Arc::new(app_state), &options, token.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        TestServer {
            base_url: format!("http://127.0.0.1:{port}"),
            token,
            port,
            handle,
        }
    }

    async fn invoke(server: &TestServer, body: Value) -> reqwest::Response {
        reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .json(&body)
            .send()
            .await
            .expect("invoke response")
    }

    fn args(values: &[&str]) -> Vec<String> {
        std::iter::once("dashboard")
            .chain(values.iter().copied())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn parse_serve_args_absent_returns_none() {
        assert_eq!(parse_serve_args(&args(&[])).unwrap(), None);
        assert_eq!(
            parse_serve_args(&args(&["--host", "0.0.0.0"])).unwrap(),
            None
        );
    }

    #[test]
    fn parse_serve_args_defaults_to_loopback_port() {
        let parsed = parse_serve_args(&args(&["--serve"]))
            .unwrap()
            .expect("serve options");
        assert_eq!(parsed.host, DEFAULT_HOST);
        assert_eq!(parsed.port, DEFAULT_PORT);
        assert!(!parsed.allow_remote);
    }

    #[test]
    fn parse_serve_args_accepts_explicit_port() {
        let parsed = parse_serve_args(&args(&["--serve", "1234"]))
            .unwrap()
            .expect("serve options");
        assert_eq!(parsed.port, 1234);
    }

    #[test]
    fn parse_serve_args_rejects_remote_without_ack() {
        let err = parse_serve_args(&args(&["--serve", "--host", "0.0.0.0"]))
            .expect_err("remote bind should require ack");
        assert!(err.contains("Refusing to bind"));
    }

    #[test]
    fn parse_serve_args_accepts_remote_with_ack() {
        let parsed = parse_serve_args(&args(&["--serve", "--host", "0.0.0.0", "--allow-remote"]))
            .unwrap()
            .expect("serve options");
        assert_eq!(parsed.host, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(parsed.allow_remote);
    }

    #[test]
    fn parse_serve_args_rejects_zero_port() {
        let err = parse_serve_args(&args(&["--serve", "0"])).expect_err("zero port rejected");
        assert!(err.contains("nonzero port"));
    }

    #[test]
    fn token_authorization_requires_bearer_header() {
        let token = "a".repeat(64);
        let mut headers = HeaderMap::new();
        assert!(!authorization_valid(&headers, &token));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert!(authorization_valid(&headers, &token));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong"),
        );
        assert!(!authorization_valid(&headers, &token));
    }

    #[test]
    fn generated_token_is_hex_64_chars() {
        let token = generate_token().expect("token");
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn launch_url_uses_fragment_token() {
        let url = launch_url(DEFAULT_HOST, 9077, "abc");
        assert_eq!(url, "http://127.0.0.1:9077/#token=abc");
        assert!(!url.contains("?token="));
    }

    #[tokio::test]
    async fn route_rejects_unauthorized_before_json_body() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{")
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn route_does_not_accept_query_token() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/invoke?token={}",
                server.base_url, server.token
            ))
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    static SLOW_RESOLVER_ENTERED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static SLOW_RESOLVER_RELEASE: (std::sync::Mutex<bool>, std::sync::Condvar) =
        (std::sync::Mutex::new(false), std::sync::Condvar::new());

    /// A database lookup that holds its thread like a SQLite call waiting on a
    /// busy lock.
    fn slow_resolver() -> Option<std::path::PathBuf> {
        SLOW_RESOLVER_ENTERED.store(true, std::sync::atomic::Ordering::SeqCst);
        let (released, wake) = &SLOW_RESOLVER_RELEASE;
        let _guard = wake
            .wait_while(released.lock().unwrap(), |released| !*released)
            .unwrap();
        None
    }

    // `#[tokio::test]` runs on a single-threaded runtime, so a command that
    // blocks its worker stalls the server and this test's own client with it.
    #[tokio::test]
    async fn a_slow_database_command_does_not_stall_other_requests() {
        SLOW_RESOLVER_ENTERED.store(false, std::sync::atomic::Ordering::SeqCst);
        *SLOW_RESOLVER_RELEASE.0.lock().unwrap() = false;
        // An independent watchdog releases a blocked runtime so a regression fails
        // instead of deadlocking the test's own HTTP client.
        let watchdog = std::thread::spawn(|| {
            let (released, wake) = &SLOW_RESOLVER_RELEASE;
            let (mut released, timeout) = wake
                .wait_timeout_while(
                    released.lock().unwrap(),
                    std::time::Duration::from_secs(10),
                    |released| !*released,
                )
                .unwrap();
            *released = true;
            wake.notify_all();
            timeout.timed_out()
        });
        let server = spawn_test_server_with_state(
            AppState::with_resolver(slow_resolver),
            DEFAULT_HOST,
            false,
        )
        .await;
        let slow = {
            let base_url = server.base_url.clone();
            let token = server.token.clone();
            tokio::spawn(async move {
                reqwest::Client::new()
                    .post(format!("{base_url}/api/invoke"))
                    .bearer_auth(token)
                    .json(&json!({ "cmd": "get_projects", "args": {} }))
                    .send()
                    .await
                    .expect("slow response")
            })
        };
        while !SLOW_RESOLVER_ENTERED.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let fast = invoke(&server, json!({ "cmd": "pi_config_path", "args": {} })).await;
        assert_eq!(fast.status(), StatusCode::OK);
        let completed_while_blocked = !*SLOW_RESOLVER_RELEASE.0.lock().unwrap();
        *SLOW_RESOLVER_RELEASE.0.lock().unwrap() = true;
        SLOW_RESOLVER_RELEASE.1.notify_all();
        assert!(!watchdog.join().unwrap(), "slow resolver watchdog expired");
        assert!(
            completed_while_blocked,
            "unrelated request waited for the slow resolver"
        );

        let slow = slow.await.expect("slow task");
        assert_eq!(slow.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn route_unknown_command_returns_json_404() {
        let server = spawn_test_server().await;
        let response = invoke(&server, json!({ "cmd": "missing_command", "args": {} })).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value = response.json().await.expect("json body");
        assert_eq!(body["error"], "Unknown command");
    }

    #[tokio::test]
    async fn api_responses_are_marked_no_store() {
        let server = spawn_test_server().await;

        // A successful command response carries data and must not be cached.
        let ok = invoke(&server, json!({ "cmd": "get_db_health", "args": {} })).await;
        assert_eq!(
            ok.headers()
                .get(reqwest::header::CACHE_CONTROL)
                .map(|v| v.to_str().unwrap().to_string()),
            Some("no-store".to_string()),
        );

        // Error responses are no-store too (they can echo arguments back).
        let err = invoke(&server, json!({ "cmd": "missing_command", "args": {} })).await;
        assert_eq!(
            err.headers()
                .get(reqwest::header::CACHE_CONTROL)
                .map(|v| v.to_str().unwrap().to_string()),
            Some("no-store".to_string()),
        );
    }

    #[tokio::test]
    async fn route_read_command_returns_json_200() {
        let server = spawn_test_server().await;
        let response = invoke(&server, json!({ "cmd": "get_db_health", "args": {} })).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.expect("json body");
        assert_eq!(body["exists"], false);
    }

    #[tokio::test]
    async fn route_malformed_json_returns_json_error() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{")
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.expect("json body");
        assert!(body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Invalid JSON"));
    }

    #[tokio::test]
    async fn route_refuses_project_scope_embedding_probe() {
        let server = spawn_test_server().await;
        let response = invoke(
            &server,
            json!({
                "cmd": "test_embedding_endpoint",
                "args": {
                    "endpoint": "https://example.com",
                    "model": "text-embedding-3-small",
                    "apiKey": null,
                    "inputType": null,
                    "truncate": null,
                    "source": "project"
                }
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.expect("json body");
        assert_eq!(body["kind"], "scope_not_allowed");
    }

    #[tokio::test]
    async fn route_blocks_metadata_embedding_probe_target() {
        let server = spawn_test_server().await;
        let response = invoke(
            &server,
            json!({
                "cmd": "test_embedding_endpoint",
                "args": {
                    "endpoint": "http://169.254.169.254",
                    "model": "text-embedding-3-small",
                    "apiKey": null,
                    "inputType": null,
                    "truncate": null,
                    "source": "user"
                }
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.expect("json body");
        assert_eq!(body["kind"], "network_error");
        assert!(body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("blocked"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn route_refuses_project_config_symlink_overwrite() {
        use std::os::unix::fs::symlink;

        let server = spawn_test_server().await;
        let dir = tempdir().expect("tempdir");
        let project = dir.path().join("project");
        let target = dir.path().join("target.jsonc");
        std::fs::create_dir_all(project.join(".cortexkit")).expect("config dir");
        let project = project.canonicalize().expect("canonical project");
        std::fs::write(&target, "{}\n").expect("target");
        symlink(
            &target,
            project.join(".cortexkit").join("magic-context.jsonc"),
        )
        .expect("symlink");

        let response = invoke(
            &server,
            json!({
                "cmd": "save_project_config",
                "args": {
                    "projectPath": project.to_string_lossy(),
                    "content": "{\"enabled\":true}"
                }
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.expect("json body");
        assert!(body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("symlink"));
    }

    #[tokio::test]
    async fn route_model_discovery_rejects_shell_like_args() {
        let server = spawn_test_server().await;
        for cmd in ["get_opencode_install_state", "get_model_catalogs"] {
            let response =
                invoke(&server, json!({ "cmd": cmd, "args": { "program": "sh" } })).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn route_accepts_loopback_host_header() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(reqwest::header::HOST, format!("127.0.0.1:{}", server.port))
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn remote_route_accepts_wildcard_host_without_origin() {
        let server = spawn_remote_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(
                reqwest::header::HOST,
                format!("192.168.1.5:{}", server.port),
            )
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn remote_route_rejects_cross_origin_for_wildcard_host() {
        let server = spawn_remote_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(
                reqwest::header::HOST,
                format!("192.168.1.5:{}", server.port),
            )
            .header(reqwest::header::ORIGIN, "http://evil.test")
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn remote_route_accepts_same_origin_for_wildcard_host() {
        let server = spawn_remote_test_server().await;
        let host = format!("192.168.1.5:{}", server.port);
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(reqwest::header::HOST, &host)
            .header(reqwest::header::ORIGIN, format!("http://{host}"))
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn route_rejects_wrong_host_header() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(reqwest::header::HOST, format!("evil.test:{}", server.port))
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn route_rejects_cross_origin_header() {
        let server = spawn_test_server().await;
        let response = reqwest::Client::new()
            .post(format!("{}/api/invoke", server.base_url))
            .bearer_auth(&server.token)
            .header(reqwest::header::ORIGIN, "http://evil.test")
            .json(&json!({ "cmd": "get_db_health", "args": {} }))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
