// This harness-free test executable can also be launched with the doctor CLI.
// The test adapter and its switch for simulating no OS prompt aren't linked into ck-mc.
#[cfg(all(test, unix))]
mod test_program {
    use std::ffi::OsStr;
    use std::fs;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::sync::Arc;

    use cortexkit_doctor::module::{self, Hooks};
    use cortexkit_doctor::FindingId;
    use cortexkit_doctor_conformance::{self as conformance, Adapter, Outcome};
    use mc_module::doctor;

    struct McAdapter {
        program: PathBuf,
        id: FindingId,
    }

    impl Adapter for McAdapter {
        fn program(&self) -> &Path {
            &self.program
        }

        fn seed(&mut self, data: &Path, config: &Path) -> io::Result<()> {
            let logs = data.join("cortexkit/magic-context/logs");
            fs::create_dir_all(&logs)?;
            let log = logs.join("magic-context.fixture.log");
            fs::write(&log, "test log\n")?;
            fs::set_permissions(log, fs::Permissions::from_mode(0o644))?;
            fs::write(config.join("untouched"), "test settings\n")
        }

        fn fixable_id(&self) -> Option<&FindingId> {
            Some(&self.id)
        }

        fn non_prompting(&self) -> bool {
            true
        }
    }

    pub fn run() -> ExitCode {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() == Some(OsStr::new("doctor")) {
            let args: Vec<_> = args.collect();
            if std::env::var_os("CORTEXKIT_DOCTOR_CONFORMANCE").as_deref() == Some(OsStr::new("1"))
                && std::env::var_os("CORTEXKIT_DOCTOR_TEST_PRESENCE").as_deref()
                    == Some(OsStr::new("no_presence"))
            {
                return module::run_with(
                    &args,
                    doctor::check,
                    doctor::preflight,
                    doctor::fix,
                    doctor::MANIFEST,
                    Hooks {
                        presence: Arc::new(|_, _| module::Outcome::NoPresence),
                        ..Hooks::default()
                    },
                );
            }
            return doctor::run(&args);
        }
        let mut adapter = McAdapter {
            program: std::env::current_exe().unwrap(),
            id: "files.not_private".parse().unwrap(),
        };
        let results = conformance::run(&mut adapter);
        assert_eq!(results.len(), 10);
        for rule in results {
            println!("{}: {:?}", rule.name, rule.outcome);
            if matches!(rule.name, "fix.module_running" | "fix.full_recheck") {
                assert!(matches!(rule.outcome, Outcome::Skipped { .. }));
            } else {
                assert_eq!(rule.outcome, Outcome::Passed, "{}", rule.name);
            }
        }
        ExitCode::SUCCESS
    }
}

#[cfg(all(test, unix))]
fn main() -> std::process::ExitCode {
    test_program::run()
}

#[cfg(not(all(test, unix)))]
fn main() {}
