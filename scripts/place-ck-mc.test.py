#!/usr/bin/env python3
"""Isolated placement preflight tests; never points at the operator's HOME."""
import hashlib
import os
import shutil
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("place-ck-mc.sh")
ROOT = SCRIPT.parent.parent
NEW = "6d76aeea576fe2a25ac6d5ed0d9c8125a1fff9f2"


def parent_of_known_commit():
    """The parent of NEW, a commit every full clone of this repository has.

    These tests need two real commits where one is the other's parent. If the
    lookup fails, the checkout has no history for NEW (it happened once on the
    build server). Print what the repository looks like before failing, so the
    cause can be found from the job's output.
    """
    try:
        return subprocess.check_output(
            ["git", "rev-parse", NEW + "^"], cwd=ROOT, text=True
        ).strip()
    except subprocess.CalledProcessError:
        probe = (
            "pwd -P; git cat-file -t HEAD; git rev-parse --is-shallow-repository; "
            "git count-objects -v; ls .git/objects/info/ .git/shallow 2>&1; "
            'echo "source commit: $CK_REMOTE_SOURCE_COMMIT"'
        )
        shown = subprocess.run(
            ["bash", "-c", probe], cwd=ROOT, capture_output=True, text=True
        )
        print(
            f"commit {NEW} has no parent in this checkout:\n{shown.stdout}{shown.stderr}",
            flush=True,
        )
        raise


OLD = parent_of_known_commit()
REAL_GIT = shutil.which("git")


def once(directory, body):
    path = directory / hashlib.sha256(body.encode()).hexdigest()
    if not path.exists():
        path.write_text(body)
        path.chmod(0o755)
    return path


class PlacementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.bin = self.home / ".local/share/cortexkit/bin"
        self.shared_staging = self.home / ".local/share/cortexkit/staging"
        self.store = root / "stores"
        self.shims = root / "shims"
        for path in (self.bin, self.store, self.shims):
            path.mkdir(parents=True)
        self.staged = once(root, f'''#!/bin/sh
case "$1" in
 --version) echo 'ck-mc 0.1.0 ({NEW})' ;;
 --print-fences) echo "${{FAKE_STAGED_FENCES:-context.db=91 sessions.db=50}}" ;;
 --print-tool-pins) printf '%s\n' "${{FAKE_STAGED_PINS:-ctx_memory 1 aaa current}}" ;;
 *) exit 2 ;;
esac
''')
        self.deployed = once(root, f'''#!/bin/sh
case "$1" in
 --version) echo 'ck-mc 0.1.0 ({OLD})' ;;
 --print-fences) echo "${{FAKE_DEPLOYED_FENCES:-context.db=90 store.db=49}}" ;;
 --print-tool-pins) printf '%s\n' "${{FAKE_DEPLOYED_PINS:-ctx_memory 1 aaa current}}" ;;
 *) exit 2 ;;
esac
''')
        (self.bin / "ck-mc").write_bytes(self.deployed.read_bytes())
        (self.bin / "ck-mc").chmod(0o755)
        for name, body in {
            "stat": '''#!/bin/sh
python3 -c 'import os,sys; print(os.stat(sys.argv[-1]).st_ino)' "$@"
''',
            "git": f'''#!/bin/sh
if [ "$1" = show ]; then
  case "$2:${{FAKE_MISSING_EPOCHS:-}}" in
    {OLD}:crates/mc-module/src/lib.rs:old|{NEW}:crates/mc-module/src/lib.rs:new|*:crates/mc-module/src/lib.rs:both)
      echo '// No render epochs in this revision.'; exit 0 ;;
  esac
fi
exec {REAL_GIT} -c safe.directory={ROOT} "$@"
''',
            "codesign": '#!/bin/sh\ncase "$1" in --verify) exit 0;; -dv) if [ "${FAKE_UNHARDENED:-}" = 1 ]; then f="0x2(adhoc)"; else f="0x10002(adhoc,runtime)"; fi; printf "Executable=x\\nIdentifier=ck-mc\\nFormat=Mach-O\\nCodeDirectory v=20500 size=1 flags=$f hashes=1+0 location=embedded\\n" >&2;; esac\n',
            "ck": '''#!/bin/sh
case "$*" in
  'module restart magic-context') [ -n "${FAKE_RESTART_LOG:-}" ] && echo restarted >> "$FAKE_RESTART_LOG"; exit 0 ;;
  'module stop magic-context')
    echo stopped >> "$FAKE_LIFECYCLE"
    touch "$FAKE_STOPPED"
    ;;
  'module start magic-context')
    if [ -f "$MAGIC_CONTEXT_STORAGE_DIR/sessions.db" ]; then store=sessions.db; else store=mode3.db; fi
    echo "started $store $("$FAKE_DEPLOYED" --version)" >> "$FAKE_LIFECYCLE"
    rm -f "$FAKE_STOPPED"
    ;;
  '--json provenance magic-context')
    # FAKE_DRAINING_POLLS makes the first N reads look like a restart still in progress:
    # the new process has not declared its build yet.
    n=$(cat "$FAKE_POLL_COUNT" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_POLL_COUNT"
    if [ -f "$FAKE_STOPPED" ]; then
      case "${FAKE_STOPPED_PROVENANCE:-}" in
        failed) exit 7 ;;
        unknown) echo '{"module":{"name":"magic-context"}}' ;;
        restarted) echo '{"modules":[{"module_id":"magic-context","daemon_observed":{"pid":4321}}]}' ;;
        null) echo '{"modules":[{"module_id":"magic-context","daemon_observed":{"pid":null},"module_declared":{}}]}' ;;
        *) echo '{"modules":[{"module_id":"magic-context","module_declared":{},"registration_declaration":{},"daemon_observed":{"running_image":{"status":"unavailable","reason":"not_running"}}}]}' ;;
      esac
    elif [ "$n" -lt "${FAKE_DRAINING_POLLS:-0}" ]; then
      echo '{"modules":[{"module_id":"magic-context","daemon_observed":{"pid":1234},"module_declared":{}}]}'
    else
      echo '{"modules":[{"module_id":"magic-context","daemon_observed":{"pid":1234},"module_declared":{"build":{"build_git_sha":"6d76aeea576fe2a25ac6d5ed0d9c8125a1fff9f2"}}}]}'
    fi ;;
  '--json health magic-context') if [ "${FAKE_BAD_HEALTH:-}" = 1 ]; then echo '{"status":"failing"}'; else echo '{"status":"ok"}'; fi ;;
  *) exit 3 ;;
esac
''',
            "lsof": '''#!/bin/sh
if [ "$2" = '-Fpcn' ]; then
    [ -f "$FAKE_STOPPED" ] || exit 2
    if [ "${FAKE_HOLDER:-}" = 1 ]; then
        for path do
            case "$path" in *.lock) printf 'p4242\\ncoffline-reader\\nn%s\\n' "$path"; exit 0;; esac
        done
    fi
    exit 1
fi
python3 -c 'import os; p=os.environ["FAKE_DEPLOYED"]; print("i" + str(os.stat(p).st_ino) + "\\nn" + p)'
''',
            "ps": '''#!/bin/sh
if [ "$2" = 4321 ] && [ "${FAKE_STOPPED_PROVENANCE:-}" = restarted ]; then echo 4321; exit 0; fi
if [ "${FAKE_WONT_STOP:-}" = 1 ] || [ ! -f "$FAKE_STOPPED" ]; then echo 1234; exit 0; fi
exit 1
''',
            "mv": f'''#!/bin/sh
if [ "${{FAKE_SWAP_FAIL:-}}" = 1 ] && [ "$*" = "-f ${{2}} $FAKE_DEPLOYED" ]; then exit 77; fi
if [ "${{FAKE_RENAME_FAIL:-}}" = 1 ] && [ "$3" = "$MAGIC_CONTEXT_STORAGE_DIR/sessions.db-shm" ]; then exit 77; fi
exec {shutil.which('mv')} "$@"
''',
            # A stripped release lists no debug-map (STABS) entries; FAKE_UNSTRIPPED
            # lists two, the shape a failed rust-objcopy strip leaves behind.
            "nm": '''#!/bin/sh
if [ "${FAKE_UNSTRIPPED:-}" = 1 ]; then
  printf '0000000000000000 - 00 0000   SO /build/src/\\n0000000000000000 - 00 0000  OSO /build/target/x.o\\n'
fi
printf '0000000100000000 T _main\\n'
''',
        }.items():
            # Stable content-addressed shim, with a command-name link for PATH lookup.
            (self.shims / name).symlink_to(once(root, body))
        self.versions(91, 49)
        isolated_env = {key: value for key, value in os.environ.items()
                        if not key.startswith("MAGIC_CONTEXT_") and not key.startswith("XDG_")}
        self.env = dict(isolated_env, HOME=str(self.home), MAGIC_CONTEXT_STORAGE_DIR=str(self.store),
                        CK_STAGING=str(self.shared_staging),
                        PATH=str(self.shims) + os.pathsep + os.environ["PATH"],
                        PYTHONPYCACHEPREFIX=str(root / "pycache"), XDG_CACHE_HOME=str(root / "cache"),
                         FAKE_DEPLOYED=str(self.bin / "ck-mc"), FAKE_POLL_COUNT=str(root / "poll-count"),
                         FAKE_STOPPED=str(root / "stopped"), FAKE_LIFECYCLE=str(root / "lifecycle"),
                        # The deployed fake reports pins: its revision contains the commit
                        # that added the flag.
                        PLACE_CK_MC_TOOL_PINS_COMMIT=OLD,
                        PLACE_CK_MC_POLL_SECONDS="0")

    def versions(self, context, store):
        for name, sql, version in (
            ("context.db", "CREATE TABLE schema_migrations(version INTEGER)", context),
            ("sessions.db", f"PRAGMA user_version = {store}", store),
        ):
            path = self.store / name
            path.unlink(missing_ok=True)
            with sqlite3.connect(path) as conn:
                conn.execute(sql)
                if name == "context.db":
                    conn.execute("INSERT INTO schema_migrations VALUES (?)", (version,))
            conn.close()

    def seed_shared_declaration(self, path=None):
        self.shared_staging.mkdir(parents=True, exist_ok=True)
        declaration = path or self.shared_staging / "magic-context.current"
        declaration.write_text(
            f"stage={self.shared_staging}/ck-mc.{OLD[:8]}\n"
            f"revision={OLD}\n"
            "declared_at=2024-01-01T00:00:00Z\n"
        )
        return declaration

    def run_script(self, *args):
        return subprocess.run(["bash", str(SCRIPT), "--dry-run", *args, str(self.staged)],
                              env=self.env, cwd=ROOT, capture_output=True, text=True)

    def place(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args, str(self.staged)],
                              env=self.env, cwd=ROOT, capture_output=True, text=True)

    def legacy_store(self):
        self.env["FAKE_DEPLOYED_FENCES"] = "context.db=91 mode3.db=49"
        previous = self.store / "mode3.db"
        (self.store / "sessions.db").rename(previous)
        return previous

    def store_with_wal(self, destination):
        source = self.store / "wal-fixture.db"
        conn = sqlite3.connect(source)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_autocheckpoint=0")
            conn.execute("PRAGMA user_version=49")
            conn.execute("CREATE TABLE saved_view(view TEXT NOT NULL)")
            conn.execute("INSERT INTO saved_view VALUES ('saved state in the WAL')")
            conn.commit()
            contents = {}
            for suffix in ("", "-wal", "-shm"):
                contents[suffix] = Path(f"{source}{suffix}").read_bytes()
                Path(f"{destination}{suffix}").write_bytes(contents[suffix])
            return contents
        finally:
            conn.close()
            source.unlink()

    def test_renames_in_both_directions_while_stopped(self):
        for destination, source in (("sessions.db", "mode3.db"), ("mode3.db", "sessions.db")):
            with self.subTest(destination=destination):
                for name in (source, destination):
                    for suffix in ("", "-wal", "-shm"):
                        (self.store / f"{name}{suffix}").unlink(missing_ok=True)
                self.versions(91, 49)
                (self.bin / "ck-mc").write_bytes(self.deployed.read_bytes())
                if source == "mode3.db":
                    self.legacy_store()
                else:
                    self.env["FAKE_STAGED_FENCES"] = "context.db=91 mode3.db=50"
                    self.env["FAKE_DEPLOYED_FENCES"] = "context.db=91 sessions.db=49"
                if self.shared_staging.exists():
                    shutil.rmtree(self.shared_staging)
                Path(self.env["FAKE_LIFECYCLE"]).unlink(missing_ok=True)
                Path(self.env["FAKE_STOPPED"]).unlink(missing_ok=True)
                payloads = self.store_with_wal(self.store / source)
                run = self.place()
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertIn("post-stop provenance did not report a PID", run.stdout)
                for suffix, payload in payloads.items():
                    self.assertFalse((self.store / f"{source}{suffix}").exists())
                    self.assertEqual((self.store / f"{destination}{suffix}").read_bytes(), payload)
                with sqlite3.connect(self.store / destination) as conn:
                    self.assertEqual(conn.execute("SELECT view FROM saved_view").fetchone(),
                                     ("saved state in the WAL",))
                conn.close()
                self.assertEqual(Path(self.env["FAKE_LIFECYCLE"]).read_text().splitlines(),
                                 ["stopped", f"started {destination} ck-mc 0.1.0 ({NEW})"])

    def test_rename_dry_run_and_no_restart_make_no_changes(self):
        old = self.legacy_store()
        self.store_with_wal(old)
        Path(f"{old}-shm").unlink()
        original = (self.bin / "ck-mc").read_bytes()
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(f"rename {old} to {self.store / 'sessions.db'}", run.stdout)
        run = self.place("--no-restart")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("old process would keep running", run.stderr)
        self.assertTrue(old.exists())
        self.assertFalse(Path(f"{old}-shm").exists(), "dry-run must not create shared memory")
        self.assertFalse((self.store / "sessions.db").exists())
        self.assertFalse(Path(self.env["FAKE_LIFECYCLE"]).exists())
        self.assertEqual((self.bin / "ck-mc").read_bytes(), original)

    def test_rename_refuses_when_pid_or_store_holder_remains(self):
        old = self.legacy_store()
        Path(f"{old}.lock").touch()
        original = (self.bin / "ck-mc").read_bytes()
        for flag, message in [("FAKE_WONT_STOP", "PID 1234"), ("FAKE_HOLDER", "offline-reader")]:
            with self.subTest(flag=flag):
                self.env[flag] = "1"
                run = self.place()
                self.env.pop(flag)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(message, run.stderr)
                self.assertTrue(old.exists())
                self.assertFalse((self.store / "sessions.db").exists())
                self.assertEqual((self.bin / "ck-mc").read_bytes(), original)
        self.assertIn(f"started mode3.db ck-mc 0.1.0 ({OLD})", Path(self.env["FAKE_LIFECYCLE"]).read_text())

    def test_failed_or_unknown_post_stop_provenance_does_not_block_a_verified_stop(self):
        for status, message in (("failed", "command failed"), ("unknown", "returned an unrecognized reply"),
                                ("null", "did not report a PID")):
            with self.subTest(status=status):
                self.versions(91, 49)
                old = self.legacy_store()
                self.env["FAKE_STOPPED_PROVENANCE"] = status
                (self.bin / "ck-mc").write_bytes(self.deployed.read_bytes())
                run = self.place()
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertIn(f"post-stop provenance {message}", run.stdout)
                self.assertFalse(old.exists())
                self.assertTrue((self.store / "sessions.db").exists())

    def test_live_post_stop_pid_refuses_without_renaming(self):
        old = self.legacy_store()
        original = (self.bin / "ck-mc").read_bytes()
        self.env["FAKE_STOPPED_PROVENANCE"] = "restarted"
        run = self.place()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("daemon reported a live magic-context PID 4321 after stop", run.stderr)
        self.assertTrue(old.exists())
        self.assertFalse((self.store / "sessions.db").exists())
        self.assertEqual((self.bin / "ck-mc").read_bytes(), original)

    def test_rename_or_binary_swap_failure_restores_store_and_restarts_original(self):
        old = self.legacy_store()
        original = (self.bin / "ck-mc").read_bytes()
        payloads = self.store_with_wal(old)
        for flag in ("FAKE_RENAME_FAIL", "FAKE_SWAP_FAIL"):
            with self.subTest(flag=flag):
                Path(self.env["FAKE_LIFECYCLE"]).unlink(missing_ok=True)
                self.env[flag] = "1"
                run = self.place()
                self.env.pop(flag)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn("restored original store and binary", run.stderr)
                for suffix, payload in payloads.items():
                    self.assertEqual(Path(f"{old}{suffix}").read_bytes(), payload)
                    self.assertFalse((self.store / f"sessions.db{suffix}").exists())
                self.assertEqual((self.bin / "ck-mc").read_bytes(), original)
                self.assertEqual(Path(self.env["FAKE_LIFECYCLE"]).read_text().splitlines(),
                                 ["stopped", f"started {old.name} ck-mc 0.1.0 ({OLD})"])

    def test_unstripped_binary_refuses(self):
        self.env["FAKE_UNSTRIPPED"] = "1"
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("carries 2 debug-map entries", run.stderr)

    def test_context_fence_refuses(self):
        self.versions(92, 49)
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("context.db live=92 staged=91; sessions.db live=49 staged=50", run.stdout + run.stderr)
        self.assertIn("rollback refused", run.stderr)

    def test_store_fence_refuses(self):
        self.versions(91, 51)
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("context.db live=91 staged=91; sessions.db live=51 staged=50", run.stdout + run.stderr)
        self.assertIn("rollback refused", run.stderr)

    def test_an_unmigrated_context_db_refuses(self):
        # ck-mc opens context.db only at exactly its own version, so placing it
        # before a host migrated the database would leave it refusing to start.
        self.versions(90, 49)
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("context.db is at 90 but this ck-mc opens only 91", run.stderr)

    def test_a_build_that_migrates_the_store_itself_may_be_placed_over_an_older_one(self):
        # From 106 on ck-mc migrates context.db when it starts, from the
        # released 0.49 plugin's version (95) up.
        self.env["FAKE_STAGED_FENCES"] = "context.db=110 sessions.db=50"
        self.versions(105, 49)
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("ck-mc migrates it from 105 to 110 when it starts", run.stdout)
        self.versions(94, 49)
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("ck-mc migrates only from 95", run.stderr)

    def test_a_tool_pin_the_staged_build_drops_refuses_unless_schemas_may_change(self):
        # A running session keeps its tool schemas until its host restarts it.
        self.env["FAKE_DEPLOYED_PINS"] = "ctx_memory 1 aaa current\nctx_note 2 bbb current"
        self.env["FAKE_STAGED_PINS"] = "ctx_memory 1 ccc current\nctx_note 2 bbb current"
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("ctx_memory 1 aaa", run.stderr)
        self.assertNotIn("ctx_note 2 bbb", run.stderr)
        run = self.run_script("--tool-schemas-changed")
        self.assertEqual(run.returncode, 0, run.stderr)
        # A semantics change drops the pin too.
        self.env["FAKE_STAGED_PINS"] = "ctx_memory 2 aaa current\nctx_note 2 bbb current"
        self.assertNotEqual(self.run_script().returncode, 0)

    def test_an_earlier_pin_the_staged_build_still_honours_passes(self):
        self.env["FAKE_DEPLOYED_PINS"] = "ctx_memory 1 aaa current"
        self.env["FAKE_STAGED_PINS"] = "ctx_memory 1 ccc current\nctx_memory 1 aaa earlier"
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("every pin the deployed build serves is honoured", run.stdout)

    def test_a_deployed_build_without_pin_reports_needs_a_reviewed_comparison(self):
        # Asked an unknown flag, an older ck-mc would start serving, so it is
        # not asked at all.
        old = once(Path(self.tmp.name), f'''#!/bin/sh
case "$1" in
 --version) echo 'ck-mc 0.1.0 ({OLD})' ;;
 --print-fences) echo 'context.db=90 store.db=49' ;;
 *) echo started >> "$FAKE_STARTED"; exit 2 ;;
esac
''')
        (self.bin / "ck-mc").write_bytes(old.read_bytes())
        self.env["FAKE_STARTED"] = str(Path(self.tmp.name) / "started")
        # Its revision predates the commit that added the flag.
        self.env["PLACE_CK_MC_TOOL_PINS_COMMIT"] = NEW
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("--tool-pins-reviewed", run.stderr)
        self.assertFalse(Path(self.env["FAKE_STARTED"]).exists())
        run = self.run_script("--tool-pins-reviewed")
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_epoch_change_advises_or_refuses(self):
        allowed = self.run_script()
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertIn("TAGGER_FEATURE_EPOCH: 3 -> 4 CHANGED", allowed.stdout)
        refused = self.run_script("--require-epochs-unchanged")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("TAGGER_FEATURE_EPOCH: 3 -> 4 CHANGED", refused.stdout)
        self.assertIn("epochs changed", refused.stderr)

    def test_missing_session_store_is_version_zero_and_old_store_is_untouched(self):
        (self.store / "sessions.db").unlink()
        old_store = self.store / "store.db"
        old_store.write_bytes(b"rollback store must not be opened")
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("sessions.db: live=0 staged=50", run.stdout)
        self.assertIn("old store.db isn't checked", run.stdout)
        self.assertEqual(old_store.read_bytes(), b"rollback store must not be opened")
        self.assertFalse((self.store / "sessions.db").exists())

    def test_missing_epochs_skip_and_strict_only_refuses_one_sided_constants(self):
        for missing, side in (("old", "deployed"), ("new", "staged"), ("both", "both deployed")):
            with self.subTest(missing=missing):
                self.env["FAKE_MISSING_EPOCHS"] = missing
                run = self.run_script()
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertIn("render-epoch check does not apply: " + side, run.stdout)
                strict = self.run_script("--require-epochs-unchanged")
                if missing == "both":
                    self.assertEqual(strict.returncode, 0, strict.stderr)
                else:
                    self.assertNotEqual(strict.returncode, 0)
                    self.assertIn(side + " (", strict.stderr)
                    self.assertIn("while the other revision has them", strict.stderr)

    def test_xdg_test_root_wins_over_explicit_storage(self):
        xdg = self.home / "xdg"
        directory = xdg / "cortexkit/magic-context"
        directory.mkdir(parents=True)
        shutil.copyfile(self.store / "context.db", directory / "context.db")
        self.env.update(XDG_DATA_HOME=str(xdg), MAGIC_CONTEXT_TEST_DATA_DIR=str(self.home / "test"))
        self.versions(999, 999)
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("context.db: live=91 staged=91; sessions.db: live=0", run.stdout)

    def test_placement_verifies_and_preserves_rollback(self):
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=self.env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("inode/version/digest/health ok", run.stdout)
        rollback = self.bin / "staging" / ("ck-mc.rollback." + OLD)
        self.assertTrue(rollback.exists())
        self.assertEqual(rollback.read_bytes().count(OLD.encode()), 1)
        self.assertEqual((self.bin / "ck-mc").read_bytes(), self.staged.read_bytes())

    def test_successful_placement_updates_shared_declaration_and_stages_exact_bytes(self):
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=self.env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)

        card_name = f"ck-mc.{NEW[:8]}"
        card = self.shared_staging / card_name
        sidecar = self.shared_staging / f"{card_name}.sha256"
        declaration = self.shared_staging / "magic-context.current"
        self.assertEqual(card.read_bytes(), (self.bin / "ck-mc").read_bytes())
        self.assertEqual(card.read_bytes(), self.staged.read_bytes())
        self.assertEqual(sidecar.read_text(), f"{hashlib.sha256(card.read_bytes()).hexdigest()}  {card_name}\n")
        verified = subprocess.run(["shasum", "-a", "256", "-c", sidecar.name],
                                  cwd=self.shared_staging, capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        expected_stage = Path(os.path.realpath(self.shared_staging)) / card_name
        self.assertRegex(
            declaration.read_text(),
            rf"^stage={expected_stage}\nrevision={NEW}\ndeclared_at=\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}:\d{{2}}:\d{{2}}Z\n$",
        )

    def test_placement_waits_for_the_restarted_module_to_declare_its_build(self):
        env = dict(self.env, FAKE_DRAINING_POLLS="3")
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("inode/version/digest/health ok", run.stdout)

    def test_failed_post_placement_check_prints_rollback_without_using_it(self):
        declaration = self.seed_shared_declaration()
        original_declaration = declaration.read_bytes()
        before = (self.bin / "ck-mc").read_bytes()
        env = dict(self.env, FAKE_BAD_HEALTH="1")
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("cp ", run.stderr)
        self.assertIn("ck module restart magic-context", run.stderr)
        self.assertNotEqual((self.bin / "ck-mc").read_bytes(), before)
        self.assertEqual(declaration.read_bytes(), original_declaration)
        self.assertFalse((self.shared_staging / f"ck-mc.{NEW[:8]}").exists())

    def test_no_restart_places_and_checks_the_file_without_restarting(self):
        restart_log = self.home / "restart-log"
        env = dict(self.env, FAKE_RESTART_LOG=str(restart_log))
        run = subprocess.run(["bash", str(SCRIPT), "--no-restart", str(self.staged)], env=env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("on disk without restarting", run.stdout)
        self.assertFalse(restart_log.exists(), "--no-restart must not restart the module")
        self.assertEqual((self.bin / "ck-mc").read_bytes(), self.staged.read_bytes())
        self.assertTrue((self.bin / "staging" / ("ck-mc.rollback." + OLD)).exists())
        placed = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=env,
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(placed.returncode, 0, placed.stderr)
        self.assertTrue(restart_log.exists(), "a normal placement restarts the module")

    def test_unhardened_build_is_refused_before_anything_moves(self):
        before = (self.bin / "ck-mc").read_bytes()
        env = dict(self.env, FAKE_UNHARDENED="1")
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("not signed with hardened runtime", run.stderr)
        self.assertEqual((self.bin / "ck-mc").read_bytes(), before)
        self.assertFalse((self.bin / "staging").exists())

    def test_dry_run_never_writes(self):
        self.seed_shared_declaration()
        def snapshot():
            return {str(p.relative_to(self.home)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in self.home.rglob("*") if p.is_file()}
        before = snapshot()
        run = self.run_script("--source-ref", NEW)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("dry-run: would preserve", run.stdout)
        self.assertEqual(snapshot(), before)
        self.assertFalse((self.bin / "staging").exists())

    def test_disagreeing_ck_prefixed_declaration_refuses_before_placement(self):
        self.shared_staging.mkdir(parents=True)
        alternate = self.shared_staging / "ck-magic-context.current"
        alternate.write_text(
            f"stage={self.shared_staging}/ck-mc.{OLD[:8]}\n"
            f"revision={OLD}\n"
            "declared_at=2024-01-01T00:00:00Z\n"
        )
        before = (self.bin / "ck-mc").read_bytes()
        run = subprocess.run(["bash", str(SCRIPT), str(self.staged)], env=self.env,
                             cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("another magic-context currency declaration disagrees", run.stderr)
        self.assertEqual((self.bin / "ck-mc").read_bytes(), before)
        self.assertEqual(list(self.shared_staging.iterdir()), [alternate])
        self.assertFalse((self.bin / "staging").exists())


if __name__ == "__main__":
    unittest.main()
