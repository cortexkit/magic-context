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
        let CommandSpec {
            name,
            refs,
            options,
            fixed,
        } = COMMANDS
            .iter()
            .find(|spec| spec.name == self.command)
            .ok_or_else(|| format!("git_read does not allow the {:?} subcommand", self.command))?;
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
        let mut args = vec![(*name).to_owned()];
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

struct CommandSpec {
    name: &'static str,
    refs: std::ops::RangeInclusive<usize>,
    options: &'static [&'static str],
    fixed: &'static [&'static str],
}

// Admission and execution use the same table. Git's defaults are not safe:
// `blame` otherwise honors checkout-configured text conversion, for example.
// Optional flags shape output only; none can undo a fixed safety flag.
const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "log",
        refs: 0..=1,
        options: &["--oneline", "--stat", "-p"],
        fixed: &[
            "--max-count=40",
            "--no-ext-diff",
            "--no-textconv",
            "--no-show-signature",
        ],
    },
    CommandSpec {
        name: "show",
        refs: 0..=1,
        options: &["--stat", "--name-only"],
        fixed: &["--no-ext-diff", "--no-textconv", "--no-show-signature"],
    },
    CommandSpec {
        name: "diff",
        refs: 2..=2,
        options: &["--stat", "--name-only", "--name-status"],
        fixed: &["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
    },
    CommandSpec {
        name: "blame",
        refs: 0..=1,
        options: &[],
        fixed: &["--no-textconv"],
    },
    CommandSpec {
        name: "ls-files",
        refs: 0..=0,
        options: &[],
        fixed: &["--cached"],
    },
];

pub(super) fn commands() -> impl Iterator<Item = &'static str> {
    COMMANDS.iter().map(|spec| spec.name)
}

pub(super) fn options() -> std::collections::BTreeSet<&'static str> {
    COMMANDS
        .iter()
        .flat_map(|spec| spec.options.iter().copied())
        .collect()
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

fn command_for(program: &str, root: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Command {
    let mut command = Command::new(program);
    git_environment(&mut command);
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
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn git_environment(command: &mut Command) {
    // Git environment overrides can redirect a command to another repository.
    // Read history without lazy network fetches, pagers, external diff drivers,
    // fsmonitor hooks, or an index lock. Use only objects already present in
    // the checkout's repository.
    command
        .env_clear()
        .env(
            "PATH",
            if cfg!(windows) {
                r"C:\Program Files\Git\cmd;C:\Windows\System32"
            } else {
                "/usr/bin:/bin"
            },
        )
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_TERMINAL_PROMPT", "0");
}

async fn git(root: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<String, String> {
    let mut child = tokio::process::Command::from(command_for("git", root, args))
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

#[cfg(test)]
mod review_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn lab_git_does_not_inherit_a_module_environment_marker() {
        const MARKER: &str = "MC_LAB_TEST_ENV_MARKER";
        if std::env::var_os(MARKER).is_none() {
            let result = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "dreamer::lab::git::review_tests::lab_git_does_not_inherit_a_module_environment_marker", "--nocapture"])
                .env(MARKER, "fixture")
                .output().unwrap();
            let output = String::from_utf8_lossy(&result.stdout);
            assert!(output.contains("running 1 test"), "{output}");
            assert!(
                result.status.success(),
                "{output}\n{}",
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        let mut probe = Command::new("/usr/bin/env");
        git_environment(&mut probe);
        let result = probe.output().unwrap();
        assert!(result.status.success());
        let env = String::from_utf8(result.stdout).unwrap();
        assert!(!env.contains(MARKER), "git inherited the test marker");
        assert!(env.lines().any(|line| line == "LC_ALL=C"));
    }

    #[tokio::test]
    async fn lab_git_allows_five_commands_without_running_textconv() {
        let repo = tempfile::tempdir().unwrap();
        let raw = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        raw(&["init", "-q"]);
        raw(&["config", "user.email", "lab@example.invalid"]);
        raw(&["config", "user.name", "Lab test"]);
        raw(&["config", "diff.sample.textconv", "wc -l"]);
        std::fs::write(
            repo.path().join(".gitattributes"),
            "fixture.log diff=sample\n",
        )
        .unwrap();
        std::fs::write(repo.path().join("fixture.log"), "original raw line\n").unwrap();
        raw(&["add", "."]);
        raw(&["commit", "-qm", "before"]);
        std::fs::write(
            repo.path().join("fixture.log"),
            "original raw line\nnew raw line\n",
        )
        .unwrap();
        raw(&["commit", "-qam", "after"]);
        let checkout = repo.path().canonicalize().unwrap();
        for (command, refs, options) in [
            ("blame", vec![], vec![]),
            ("show", vec![], vec![]),
            ("diff", vec!["HEAD~1", "HEAD"], vec![]),
            ("log", vec![], vec!["-p"]),
            ("ls-files", vec![], vec![]),
        ] {
            let request: Request = serde_json::from_value(serde_json::json!({
                "checkout":"fixture", "command":command, "refs":refs,
                "options":options, "paths":["fixture.log"]
            }))
            .unwrap();
            let output = request.read(&checkout).await.unwrap();
            let expected = if command == "ls-files" {
                "fixture.log"
            } else {
                "new raw line"
            };
            assert!(
                output.contains(expected),
                "{command} did not return {expected:?}: {output}"
            );
        }
    }
}
