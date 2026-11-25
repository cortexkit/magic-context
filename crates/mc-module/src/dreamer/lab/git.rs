//! Git reads use committed objects, literal paths and a fixed argv grammar.

use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

const MAX_OUTPUT: usize = 32 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub checkout: String,
    command: String,
    #[serde(default)]
    refs: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    options: Vec<String>,
}

impl Request {
    pub(super) async fn read(self, root: &Path) -> Result<String, String> {
        let args = self.arguments(root).await?;
        git(root, &args).await
    }

    async fn arguments(&self, root: &Path) -> Result<Vec<String>, String> {
        // Only output shaping is allowed: short log summaries and diff file
        // summaries. No model-supplied numeric limits, formats or git config.
        let (refs, options, fixed): (_, &[_], &[_]) = match self.command.as_str() {
            "log" => (
                0..=1,
                &["--oneline", "--stat"],
                &[
                    "--max-count=40",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-show-signature",
                ],
            ),
            "show" => (
                0..=1,
                &["--stat", "--name-only"],
                &["--no-ext-diff", "--no-textconv", "--no-show-signature"],
            ),
            "diff" => (
                2..=2,
                &["--stat", "--name-only", "--name-status"],
                &["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
            ),
            "blame" => (0..=1, &[], &[]),
            "ls-files" => (0..=0, &[], &["--cached"]),
            other => return Err(format!("git_read does not allow the {other:?} subcommand")),
        };
        if !refs.contains(&self.refs.len()) {
            return Err(format!("git {} expects {refs:?} refs", self.command));
        }
        if let Some(option) = self
            .options
            .iter()
            .find(|option| !options.contains(&option.as_str()))
        {
            return Err(format!(
                "git {} does not allow option {option:?}",
                self.command
            ));
        }
        if self.paths.len() > 16 || (self.command == "blame" && self.paths.len() != 1) {
            return Err("git_read takes at most 16 paths (blame requires exactly one)".into());
        }
        for path in &self.paths {
            validate_path(root, path)?;
        }
        let mut args = vec![self.command.clone()];
        args.extend(fixed.iter().map(|value| (*value).to_owned()));
        args.extend(self.options.iter().cloned());
        let refs: Vec<&str> = if self.refs.is_empty() && self.command != "ls-files" {
            vec!["HEAD"]
        } else {
            self.refs.iter().map(String::as_str).collect()
        };
        for reference in refs {
            args.push(resolve_commit(root, reference).await?);
        }
        args.push("--".into());
        args.extend(self.paths.iter().cloned());
        Ok(args)
    }
}

fn validate_path(root: &Path, path: &str) -> Result<(), String> {
    let refused = || format!("git_read path {path:?} must stay inside the checkout");
    if path.is_empty() || path.len() > 4096 || path.contains(['\\', ':', '\0']) {
        return Err(refused());
    }
    let mut inside = root.to_owned();
    for part in Path::new(path).components() {
        let Component::Normal(part) = part else {
            return Err(refused());
        };
        if part.eq_ignore_ascii_case(".git") {
            return Err(refused());
        }
        inside.push(part);
        // Historical files may no longer exist. Check each existing ancestor
        // including dangling links, which canonicalize alone would miss.
        match inside.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(refused()),
            Ok(_) => {
                if !inside
                    .canonicalize()
                    .is_ok_and(|real| real.starts_with(root))
                {
                    return Err(refused());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", inside.display())),
        }
    }
    Ok(())
}

async fn resolve_commit(root: &Path, reference: &str) -> Result<String, String> {
    // No reflog selectors, ranges, revision:path, URL, or absolute/parent
    // paths. Resolve one local commit and use only its object id downstream.
    if reference.is_empty()
        || reference.len() > 256
        || reference.starts_with(['-', '/'])
        || reference.contains("..")
        || !reference
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./-~^".contains(&byte))
    {
        return Err(format!(
            "git_read ref {reference:?} is not a local commit ref"
        ));
    }
    let commit = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )
    .await?;
    let commit = commit.trim();
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "git did not resolve {reference:?} to one commit id"
        ));
    }
    Ok(commit.into())
}

pub(super) async fn check_worktree(root: &Path) -> Result<(), String> {
    let top = git(root, &["rev-parse", "--show-toplevel"]).await?;
    let top = Path::new(top.trim_end_matches(['\r', '\n']));
    if top.canonicalize().as_deref().ok() != Some(root) {
        return Err(format!(
            "{} is not the root of a git worktree",
            root.display()
        ));
    }
    Ok(())
}

async fn git(root: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<String, String> {
    let mut command = Command::new("git");
    // Git environment overrides can redirect a command to another repository.
    // Read history without lazy network fetches, pagers, external diff drivers,
    // fsmonitor hooks, or an index lock. Use only objects already present in
    // the checkout's repository.
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "protocol.allow=never",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "color.ui=false",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("starting git: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    async fn read(mut stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        (&mut stream)
            .take((MAX_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        // Drain the pipe without growing the result, so git can exit normally.
        tokio::io::copy(&mut stream, &mut tokio::io::sink()).await?;
        Ok(bytes)
    }
    let (status, mut out, mut err) = tokio::time::timeout(TIMEOUT, async {
        tokio::try_join!(child.wait(), read(stdout), read(stderr))
    })
    .await
    .map_err(|_| "git_read timed out".to_owned())?
    .map_err(|error| format!("reading git output: {error}"))?;
    if !status.success() {
        err.truncate(MAX_OUTPUT);
        return Err(format!(
            "git failed: {}",
            String::from_utf8_lossy(&err).trim()
        ));
    }
    let truncated = out.len() > MAX_OUTPUT;
    out.truncate(MAX_OUTPUT);
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if truncated {
        text.push_str("\n[git output truncated]");
    }
    Ok(text)
}
