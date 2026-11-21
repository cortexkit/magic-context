//! Managed settings: where the user tier comes from before and after the
//! daemon answers, the saved view, the one-time rewrite, and the hooks.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use subc_client_rs::config::{
    ConfigAvailability, ConfigState, ConfigStatus, ConfigView, Layer, LayerValue, ValidationContext,
};

use super::*;
use crate::config::Loader;

const OPUS: &str = "anthropic/claude-opus-5-5";

struct Home {
    _root: tempfile::TempDir,
    user: PathBuf,
    data: PathBuf,
}

/// A user file holding `user`, and an empty data folder.
fn home(user: &Value) -> Home {
    let root = tempfile::tempdir().unwrap();
    let user_path = root.path().join("config/magic-context.jsonc");
    fs::create_dir_all(user_path.parent().unwrap()).unwrap();
    fs::write(&user_path, serde_json::to_string_pretty(user).unwrap()).unwrap();
    let data = root.path().join("data");
    fs::create_dir_all(&data).unwrap();
    Home {
        user: user_path,
        data,
        _root: root,
    }
}

/// The view the daemon would deliver for `user`.
fn view(user: Value, generation: u64) -> ConfigView {
    let tuple = super::super::review::schema()
        .review_tuple(
            &[LayerValue::new(Layer::User, user)],
            &ValidationContext::new("magic-context", None),
        )
        .unwrap();
    ConfigView::new(
        generation,
        tuple.effective,
        tuple.sources,
        vec![],
        ConfigStatus::Active,
    )
}

fn threshold(loader: &Loader) -> f64 {
    loader
        .resolve(None, OPUS, 200_000)
        .execute_threshold_percentage
}

/// The file says 80; every view in these tests says 70; the default is 65.
fn file_at_80() -> Value {
    json!({"execute_threshold_percentage": {"default": 80}})
}

fn refusal(view: ConfigAvailability) -> ConfigState {
    ConfigState::ConfigGated {
        view,
        refusal: subc_protocol::ErrorBody::new("config_gated", "the settings wait for approval"),
    }
}

#[test]
fn a_saved_view_is_served_at_once_until_this_runs_view_arrives() {
    let home = home(&file_at_80());
    let first = Loader::with_user_path(home.user.clone()).managed(&home.data);
    first
        .config_apply(&view(
            json!({"execute_threshold_percentage": {"default": 70}}),
            4,
        ))
        .unwrap();
    // The next run starts from the saved view, without waiting and without
    // reading the user file.
    let next = Loader::with_user_path(home.user.clone()).managed(&home.data);
    let started = Instant::now();
    assert_eq!(threshold(&next), 70.0);
    assert_eq!(next.settings_source().as_str(), "saved_view");
    assert!(started.elapsed() < Duration::from_secs(1));
    // A refusal leaves the approved view in force.
    next.on_config_state(&refusal(ConfigAvailability::NoApprovedConfig));
    assert_eq!(threshold(&next), 70.0);
    next.config_apply(&view(
        json!({"execute_threshold_percentage": {"default": 75}}),
        5,
    ))
    .unwrap();
    assert_eq!(threshold(&next), 75.0);
}

#[test]
fn the_first_run_waits_for_the_daemons_first_view() {
    let home = home(&file_at_80());
    let loader = std::sync::Arc::new(Loader::with_user_path(home.user.clone()).managed(&home.data));
    let daemon = {
        let loader = std::sync::Arc::clone(&loader);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            loader
                .config_apply(&view(
                    json!({"execute_threshold_percentage": {"default": 70}}),
                    1,
                ))
                .unwrap();
        })
    };
    let started = Instant::now();
    assert_eq!(threshold(&loader), 70.0);
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(250), "{waited:?}");
    assert!(waited < FIRST_STATE_WAIT, "{waited:?}");
    daemon.join().unwrap();
}

#[test]
fn a_refusal_with_no_approved_view_serves_the_defaults_not_the_file() {
    let home = home(&file_at_80());
    let loader = std::sync::Arc::new(Loader::with_user_path(home.user.clone()).managed(&home.data));
    let daemon = {
        let loader = std::sync::Arc::clone(&loader);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            loader.on_config_state(&refusal(ConfigAvailability::NoApprovedConfig));
        })
    };
    let started = Instant::now();
    assert_eq!(threshold(&loader), 65.0);
    assert!(started.elapsed() < FIRST_STATE_WAIT);
    daemon.join().unwrap();
    // Even a read whose values were discarded would populate the file cache.
    assert!(!loader.cache.lock().unwrap().contains_key(&home.user));
    // A view approved later replaces the defaults.
    loader
        .config_apply(&view(
            json!({"execute_threshold_percentage": {"default": 70}}),
            2,
        ))
        .unwrap();
    assert_eq!(threshold(&loader), 70.0);
}

#[test]
fn no_answer_within_the_wait_serves_the_defaults() {
    let home = home(&file_at_80());
    let loader = Loader::with_user_path(home.user.clone()).managed(&home.data);
    let started = Instant::now();
    assert_eq!(threshold(&loader), 65.0);
    assert!(started.elapsed() >= FIRST_STATE_WAIT);
    assert_eq!(loader.settings_source().as_str(), "defaults");
    assert!(!loader.cache.lock().unwrap().contains_key(&home.user));
    // It waits once: later resolutions don't wait again.
    let again = Instant::now();
    assert_eq!(threshold(&loader), 65.0);
    assert!(again.elapsed() < Duration::from_secs(1));
}

#[test]
fn a_daemon_without_a_config_gate_has_the_user_file_read() {
    let home = home(&json!({"execute_threshold_percentage": {"default": 80}, "clock_note": "off"}));
    let loader = Loader::with_user_path(home.user.clone()).managed(&home.data);
    loader.config_files();
    assert_eq!(loader.settings_source().as_str(), "file");
    let settings = loader.resolve(None, OPUS, 200_000);
    assert_eq!(settings.execute_threshold_percentage, 80.0);
    // The file is read in the managed shape: `clock_note: "off"` switches
    // the clock note off.
    assert_eq!(settings.clock_note, None);
}

#[test]
fn a_command_without_the_daemon_serves_the_saved_view_or_the_defaults_at_once() {
    let home = home(&file_at_80());
    let started = Instant::now();
    let offline = Loader::with_user_path(home.user.clone()).managed_offline(&home.data);
    assert_eq!(threshold(&offline), 65.0);
    Loader::with_user_path(home.user.clone())
        .managed(&home.data)
        .config_apply(&view(
            json!({"execute_threshold_percentage": {"default": 70}}),
            3,
        ))
        .unwrap();
    let offline = Loader::with_user_path(home.user.clone()).managed_offline(&home.data);
    assert_eq!(threshold(&offline), 70.0);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn each_applied_view_is_saved_whole_or_not_at_all() {
    let home = home(&file_at_80());
    let loader = Loader::with_user_path(home.user.clone()).managed(&home.data);
    loader
        .config_apply(&view(
            json!({"execute_threshold_percentage": {"default": 70}, "embedding": {"api_key": {"kind": "vault", "key": {"vault_ref": "openai"}}}}),
            7,
        ))
        .unwrap();
    let saved: Value =
        serde_json::from_slice(&fs::read(home.data.join(VIEW_FILE)).unwrap()).unwrap();
    assert_eq!(saved["generation"], 7);
    assert_eq!(
        saved["effective"]["execute_threshold_percentage"]["default"],
        70
    );
    assert_eq!(
        saved["sources"]["/execute_threshold_percentage/default"],
        "user"
    );
    // Only the saved view is left in the folder, no temporary file.
    let names: Vec<_> = fs::read_dir(&home.data)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, [VIEW_FILE]);
    // A view that can't be saved is refused, and the one in force stays.
    let blocked = home.data.join("blocked");
    fs::write(&blocked, "a file where the folder should be").unwrap();
    let stuck = Loader::with_user_path(home.user.clone()).managed(&blocked);
    stuck.config_files();
    assert!(stuck
        .config_apply(&view(
            json!({"execute_threshold_percentage": {"default": 75}}),
            8
        ))
        .is_err());
    assert_eq!(threshold(&stuck), 80.0);
}

#[test]
fn the_declaration_names_the_schema_and_the_user_file() {
    let home = home(&json!({}));
    let declaration = Loader::with_user_path(home.user.clone())
        .managed(&home.data)
        .config_declaration()
        .unwrap();
    assert_eq!(&declaration.schema, super::super::review::schema_value());
    assert_eq!(declaration.user_file, home.user.to_string_lossy());
    assert!(declaration.project_dirs.is_empty());
    // A loader that reads files declares nothing.
    assert!(Loader::with_user_path(home.user.clone())
        .config_declaration()
        .is_none());
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn the_rewrite_converts_once_keeps_the_comments_and_saves_the_old_bytes() {
    let home = home(&json!({}));
    let old = "{\n  // Summarize later.\n  \"execute_threshold_percentage\": 70,\n  \"clock_note\": false, // quiet\n  \"cache_ttl\": \"5m\"\n}\n";
    fs::write(&home.user, old).unwrap();
    let Rewrite::Rewritten(saved) = rewrite_0_49(&home.user, &home.data) else {
        panic!("not rewritten");
    };
    assert_eq!(
        read(&home.user),
        "{\n  // Summarize later.\n  \"execute_threshold_percentage\": {\n    \"default\": 70\n  },\n  \"clock_note\": \"off\" // quiet\n}\n"
    );
    assert!(saved.starts_with(home.data.join(BACKUP_FOLDER)));
    assert_eq!(read(&saved), old);
    // No temporary file is left beside the user file.
    let names: Vec<_> = fs::read_dir(home.user.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["magic-context.jsonc"]);
    // The second start finds nothing to convert.
    assert_eq!(rewrite_0_49(&home.user, &home.data), Rewrite::Unchanged);
    assert_eq!(
        fs::read_dir(home.data.join(BACKUP_FOLDER)).unwrap().count(),
        1
    );
}

#[test]
fn a_file_with_nothing_to_convert_or_a_syntax_issue_is_left_untouched() {
    let home = home(&json!({}));
    for text in [
        "{\n  // Nothing to do.\n  \"clock_note\": \"1h\"\n}\n",
        "{\n  \"clock_note\": false\n  \"language\": \"en\"\n}\n",
    ] {
        fs::write(&home.user, text).unwrap();
        let modified = fs::metadata(&home.user).unwrap().modified().unwrap();
        let rewrite = rewrite_0_49(&home.user, &home.data);
        assert!(
            matches!(rewrite, Rewrite::Unchanged | Rewrite::Refused(_)),
            "{rewrite:?}"
        );
        assert_eq!(read(&home.user), text);
        assert_eq!(
            fs::metadata(&home.user).unwrap().modified().unwrap(),
            modified
        );
        assert!(!home.data.join(BACKUP_FOLDER).exists());
    }
    let Rewrite::Refused(why) = rewrite_0_49(&home.user, &home.data) else {
        panic!("a syntax issue is refused");
    };
    assert!(why.contains("syntax issue at 3:"), "{why}");
    fs::remove_file(&home.user).unwrap();
    assert_eq!(rewrite_0_49(&home.user, &home.data), Rewrite::Missing);
}

#[test]
fn a_repeated_key_to_remove_or_rename_refuses_the_whole_rewrite() {
    let home = home(&json!({}));
    for (text, key) in [
        (
            r#"{"$schema":"old","cache_ttl":"5m","cache_ttl":"1h"}"#,
            "/cache_ttl",
        ),
        (
            r#"{"$schema":"old","dreamer":{"disable":false,"disable":true}}"#,
            "/dreamer/disable",
        ),
    ] {
        fs::write(&home.user, text).unwrap();
        let rewrite = rewrite_0_49(&home.user, &home.data);
        let Rewrite::Refused(why) = rewrite else {
            panic!("expected a refusal for {key}, got {rewrite:?}");
        };
        assert!(
            why.contains(&format!("{key} is written more than once")),
            "{why}"
        );
        assert!(
            why.contains("Remove the extra copies and restart Magic Context"),
            "{why}"
        );
        assert_eq!(read(&home.user), text);
        assert!(!home.data.join(BACKUP_FOLDER).exists());
    }
}

#[cfg(unix)]
#[test]
fn a_linked_user_file_is_rewritten_where_it_points() {
    let home = home(&json!({}));
    let target = home.data.join("dotfiles-magic-context.jsonc");
    fs::write(&target, "{\"clock_note\": false}").unwrap();
    fs::remove_file(&home.user).unwrap();
    std::os::unix::fs::symlink(&target, &home.user).unwrap();
    assert!(matches!(
        rewrite_0_49(&home.user, &home.data),
        Rewrite::Rewritten(_)
    ));
    assert!(fs::symlink_metadata(&home.user)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read(&target), "{\"clock_note\": \"off\"}");
}
