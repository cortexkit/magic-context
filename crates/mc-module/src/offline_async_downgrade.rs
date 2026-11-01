//! Offline restoration of provider records for binaries using inline payloads.
use crate::offline_move::{check_store_holders, HolderCheck, Lsof, Refusal};
use std::path::{Path, PathBuf};

const USAGE: &str = "ck-mc offline downgrade-async-layout --store-db <path> --context-db <path>";

fn parse(args: &[String]) -> Result<(PathBuf, PathBuf), String> {
    let (mut store, mut context) = (None, None);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let slot = match arg.as_str() {
            "--store-db" => &mut store,
            "--context-db" => &mut context,
            _ => return Err(USAGE.into()),
        };
        if slot.is_some() {
            return Err(USAGE.into());
        }
        *slot = Some(PathBuf::from(iter.next().ok_or(USAGE)?));
    }
    Ok((store.ok_or(USAGE)?, context.ok_or(USAGE)?))
}

fn run(store: &Path, context: &Path, holders: &dyn HolderCheck) -> Result<Vec<String>, Refusal> {
    check_store_holders(&[store.into(), context.into()], holders)?;
    mc_store::McStore::downgrade_async_layout_offline(store)
        .map_err(|error| Refusal::new("downgrade_failed", error.to_string()))
}

pub(crate) fn cli_main(args: &[String]) -> i32 {
    let result = parse(args)
        .map_err(|detail| Refusal::new("usage", detail))
        .and_then(|(store, context)| run(&store, &context, &Lsof));
    match result {
        Ok(references) => {
            println!(
                "{}",
                serde_json::json!({"status":"downgraded","sessions":references})
            );
            0
        }
        Err(refusal) => {
            println!(
                "{}",
                serde_json::json!({"status":"refused","refusal":{"code":refusal.code,"detail":refusal.detail}})
            );
            eprintln!("ASYNC DOWNGRADE REFUSED: {refusal}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Holders {
        seen: Mutex<Vec<PathBuf>>,
        result: Result<Vec<String>, String>,
    }
    impl HolderCheck for Holders {
        fn holders(&self, files: &[PathBuf]) -> Result<Vec<String>, String> {
            *self.seen.lock().unwrap() = files.to_vec();
            self.result.clone()
        }
    }

    #[test]
    fn refuses_holders_and_unproved_exclusivity_before_opening_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("store.db");
        let context = dir.path().join("context.db");
        for result in [
            Ok(vec!["other-process".into()]),
            Err("lsof unavailable".into()),
        ] {
            let holders = Holders {
                seen: Mutex::new(Vec::new()),
                result,
            };
            let error = run(&store, &context, &holders).unwrap_err();
            assert!(matches!(
                error.code,
                "stores_in_use" | "offline_exclusivity_unproven"
            ));
            let seen = holders.seen.lock().unwrap();
            for name in [
                "store.db",
                "store.db-wal",
                "store.db-shm",
                "context.db",
                "context.db-wal",
                "context.db-shm",
            ] {
                assert!(
                    seen.contains(&dir.path().join(name)),
                    "missing holder target {name}"
                );
            }
            assert!(!store.exists());
        }
    }

    #[test]
    fn requires_explicit_database_paths_without_move_session_arguments() {
        assert_eq!(
            parse(&["--store-db", "store.db", "--context-db", "context.db"].map(String::from))
                .unwrap(),
            (PathBuf::from("store.db"), PathBuf::from("context.db"))
        );
        assert!(parse(&[]).is_err());
        assert!(parse(&["--store-db", "store.db"].map(String::from)).is_err());
        assert!(parse(&["--session", "s"].map(String::from)).is_err());
    }
}
