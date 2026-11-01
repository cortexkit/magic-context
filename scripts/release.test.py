#!/usr/bin/env python3
"""Run release gates in disposable repositories, with offline gh and runner fixtures.

Run: timeout 180s python3 scripts/release.test.py -v
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any
import unittest

SCRIPTS = Path(__file__).resolve().parent
REAL_GIT = shutil.which("git")
REAL_BUN = shutil.which("bun")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="release-gate-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(TEST_ROOT=str(self.root), REAL_GIT=str(REAL_GIT), REAL_BUN=str(REAL_BUN),
                        TMPDIR=str(self.root),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        PYTHONDONTWRITEBYTECODE="1", HOME=str(self.root / "home"),
                        CI_GATE_MISSING_RUN_RETRY_SECONDS="0")
        self.git("init", "-b", "master")
        self.git("config", "user.name", "Release Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        scripts = self.repo / "scripts"
        scripts.mkdir()
        for name in ("release.sh", "ci-gate.py", "check-release-bump.py", "version-sync.mjs"):
            shutil.copyfile(SCRIPTS / name, scripts / name)
        for name in ("run-rust-hermetic-e2e.sh", "release-e2e-docker.sh"):
            path = scripts / name
            path.write_text("#!/bin/sh\necho 'Unexpected local e2e gate' >&2\nexit 42\n")
            path.chmod(0o755)
        for package in ("plugin", "pi-plugin", "cli"):
            path = self.repo / "packages" / package
            path.mkdir(parents=True)
            (path / "package.json").write_text(json.dumps({"name": package, "version": "1.0.0"}) + "\n")
        crates = ("mc-core", "mc-store", "mc-module", "mc-tokenizer")
        for crate in crates:
            path = self.repo / "crates" / crate
            path.mkdir(parents=True)
            (path / "Cargo.toml").write_text(
                f'[package]\nname = "{crate}"\nversion = "1.0.0"\nedition = "2021"\n'
            )
        lock_packages = [f'[[package]]\nname = "{crate}"\nversion = "1.0.0"\n' for crate in crates]
        (self.repo / "Cargo.lock").write_text(
            'version = 4\n\n[[package]]\nname = "fixture-external"\nversion = "2.3.4"\n\n'
            + "\n".join(lock_packages)
        )
        (self.repo / "README.md").write_text("fixture readme\n")
        (self.repo / "packages/plugin/README.md").write_text("fixture readme\n")
        (self.repo / "CHANGELOG.md").write_text("# Changelog\n")
        (self.repo / "source.ts").write_text("certified source\n")
        schema = self.repo / "assets/magic-context.schema.json"
        schema.parent.mkdir(parents=True)
        schema.write_text('{"fixture": "fresh schema"}\n')
        seeds = self.repo / "packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts"
        seeds.parent.mkdir(parents=True)
        seeds.write_text('export const seed = "fresh seed";\n')
        notes = self.repo / ".cortexkit/release-notes/v9.8.7.md"
        notes.parent.mkdir(parents=True)
        notes.write_text("Public release notes\n")
        self.git("add", ".")
        self.git("commit", "-m", "Fixture base")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.scenario: dict[str, Any] = {"base": self.base}
        shims = self.root / "shims"
        shims.mkdir()
        fixture = (SCRIPTS / "release-test-fixtures/command-shim.py").read_text().split("\n", 1)[1]
        for name in ("gh", "git", "bun", "curl"):
            path = shims / name
            path.write_text(f"#!{shutil.which('python3')}\n" + fixture)
            path.chmod(0o755)
        self.env["PATH"] = str(shims) + os.pathsep + os.environ["PATH"]

    def git(self, *args):
        result = subprocess.run([str(REAL_GIT), *args], cwd=self.repo, env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def run_script(self, sha=None):
        (self.root / "scenario.json").write_text(json.dumps(self.scenario))
        return subprocess.run(["bash", "scripts/release.sh", "9.8.7", "--ci-gate=" + (sha or self.base)],
                              cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30)

    def commands(self, name):
        path = self.root / "commands.jsonl"
        entries = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [entry["args"] for entry in entries if entry["name"] == name]

    def assert_no_publish(self):
        self.assertFalse(any(args[0] == "push" or args[:2] == ["tag", "-a"] for args in self.commands("git")))

    def test_each_workflow_must_succeed_on_exact_sha(self):
        for workflow in ("CI", "Smoke"):
            for override in ({"conclusion": "failure"}, {"status": "in_progress", "conclusion": None}, {"head_sha": "a" * 40}):
                with self.subTest(workflow=workflow, override=override):
                    self.scenario["workflows"] = {workflow: override}
                    run = self.run_script()
                    self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
                    self.assertIn(workflow + " for " + self.base, run.stderr)
                    self.assertIn("not completed/success", run.stderr)
                    self.assert_no_publish()
                    self.assertFalse(self.commands("bun"))

    def test_missing_workflow_refuses(self):
        self.scenario["missing"] = "Smoke"
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("Smoke for " + self.base + ": missing", run.stderr)
        # CI is found at once; Smoke is looked up once and then
        # retried four times before the release is refused.
        lookups = [args for args in self.commands("gh") if any("/actions/runs?head_sha=" in arg for arg in args)]
        self.assertEqual(len(lookups), 1 + 1 + 4)
        self.assert_no_publish()

    def test_newer_failed_run_cannot_reuse_older_success(self):
        self.scenario["extra_runs"] = [{"id": 100, "name": "CI", "head_sha": self.base, "status": "completed", "conclusion": "failure"}]
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("completed/failure", run.stderr)
        self.assert_no_publish()

    def test_api_failure_refuses(self):
        self.scenario["api_failure"] = True
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assert_no_publish()

    def test_release_requires_completed_slow_modes_on_the_candidate(self):
        for jobs in ([], [{"name": "Slow unit (normal)", "status": "completed", "conclusion": "success"}],
                     [{"name": "Slow unit (normal)", "status": "completed", "conclusion": "skipped"}]):
            with self.subTest(jobs=jobs):
                self.scenario["slow_jobs"] = jobs
                run = self.run_script()
                self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertIn("required slow lane", run.stderr)
                self.assert_no_publish()

    def test_tag_workflow_always_requires_rust_build_and_shards(self):
        workflow = (SCRIPTS.parent / ".github/workflows/release.yml").read_text()
        self.assertNotIn("RELEASE_SKIP_RUST_E2E", workflow)
        for name in ("e2e-rust-hermetic-build", "e2e-rust-hermetic", "publish-npm", "publish-npm-pi", "publish-npm-cli"):
            block = re.search(r"^  " + name + r":\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.MULTILINE | re.DOTALL)
            self.assertIsNotNone(block, name)
            assert block is not None
            if name.startswith("e2e-"):
                self.assertNotRegex(block.group(1), r"(?m)^    if:")
            else:
                condition = block.group(1).split("    if: >-\n", 1)[1].split("    steps:", 1)[0]
                self.assertIn("needs.e2e-rust-hermetic-build.result == 'success'", condition)
                self.assertIn("needs.e2e-rust-hermetic.result == 'success'", condition)
                self.assertNotIn("||", condition)

    def test_green_exact_sha_skips_all_local_gates_but_builds_and_checks_artifacts(self):
        run = self.run_script(sha=self.base[:12])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("host and Rust legs: covered by CI", run.stdout)
        runners = self.commands("bun")
        self.assertEqual(sum(args[-1] == "build" for args in runners), 3)
        self.assertTrue(any(args[-1] == "audit:packed-packages" for args in runners))
        self.assertTrue(any(args[:1] == ["scripts/version-sync.mjs"] for args in runners))
        self.assertIn(["packages/plugin/scripts/build-schema.ts"], runners)
        self.assertIn(["packages/plugin/scripts/build-reference-seeds.ts"], runners)
        self.assertFalse(any(arg in ("lint", "typecheck", "test") for args in runners for arg in args))
        changed = set(self.git("diff", "--name-only", self.base, "HEAD").splitlines())
        self.assertEqual(
            changed,
            {f"packages/{package}/package.json" for package in ("plugin", "pi-plugin", "cli")}
            | {f"crates/{crate}/Cargo.toml" for crate in ("mc-core", "mc-store", "mc-module", "mc-tokenizer")}
            | {"Cargo.lock"},
        )
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertTrue(any(args[:2] == ["tag", "-a"] for args in self.commands("git")))
        self.assertEqual(self.git("worktree", "list", "--porcelain").count("worktree "), 1)
        self.assertEqual(list(self.root.glob("magic-context-release.*")), [])
        self.assertTrue(any(args[:2] == ["run", "watch"] for args in self.commands("gh")))

    def assert_stale_generated_refused(self, path, stale, fresh):
        (self.repo / path).write_text(stale)
        self.git("add", path)
        self.git("commit", "-m", "Fixture stale generated artifact")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.scenario["base"] = self.base
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("generated artifacts differ from HEAD; refusing CI reuse", run.stdout)
        self.assertIn("diff --git a/" + path + " b/" + path, run.stdout)
        self.assertIn(fresh, run.stdout)
        self.assertIn(["packages/plugin/scripts/build-schema.ts"], self.commands("bun"))
        self.assertIn(["packages/plugin/scripts/build-reference-seeds.ts"], self.commands("bun"))
        self.assertIn(["checkout", "--", "assets/magic-context.schema.json",
                       "packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts"], self.commands("git"))
        self.assertEqual((self.repo / path).read_text(), stale)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertFalse(any(args[:1] == ["scripts/version-sync.mjs"] for args in self.commands("bun")))
        self.assert_no_publish()

    def test_ci_gate_refuses_stale_schema_and_restores_generated_files(self):
        self.assert_stale_generated_refused("assets/magic-context.schema.json", '{"fixture": "stale schema"}\n', "fresh schema")

    def test_ci_gate_refuses_stale_reference_seeds_and_restores_generated_files(self):
        self.assert_stale_generated_refused("packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts",
                                            'export const seed = "stale seed";\n', "fresh seed")

    def test_ci_gate_generator_failure_refuses_and_restores_generated_files(self):
        schema = self.repo / "assets/magic-context.schema.json"
        schema.write_text('{"fixture": "stale schema"}\n')
        self.git("add", ".")
        self.git("commit", "-m", "Fixture stale schema before failed generation")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.scenario.update(base=self.base, fail_generator="schema")
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("Schema generation failed", run.stdout)
        self.assertEqual(schema.read_text(), '{"fixture": "stale schema"}\n')
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assert_no_publish()

    def test_ci_gate_generator_failure_without_drift_still_refuses(self):
        self.scenario["fail_generator"] = "seeds"
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("Reference-seed generation failed", run.stdout)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assert_no_publish()

    def test_bump_refuses_non_version_notes_file_before_commit(self):
        self.scenario["stage_source"] = True
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI reuse refuses non-version/notes change: source.ts", run.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assert_no_publish()

    def test_bump_refuses_non_version_manifest_content(self):
        self.scenario["manifest_dependency"] = True
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI reuse refuses non-version manifest change", run.stderr)
        self.assert_no_publish()

    def test_version_sync_updates_cargo_manifests_and_lock_consistently(self):
        run = subprocess.run([str(REAL_BUN), "scripts/version-sync.mjs", "9.8.7"],
                             cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        crates = ("mc-core", "mc-store", "mc-module", "mc-tokenizer")
        for crate in crates:
            manifest = (self.repo / "crates" / crate / "Cargo.toml").read_text()
            self.assertIn('version = "9.8.7"', manifest)
        lock = (self.repo / "Cargo.lock").read_text()
        versions = {}
        for block in re.split(r"(?m)(?=^\[\[package\]\])", lock):
            name = re.search(r'(?m)^name = "([^"]+)"$', block)
            package_version = re.search(r'(?m)^version = "([^"]+)"$', block)
            if name is not None and package_version is not None:
                versions[name.group(1)] = package_version.group(1)
        self.assertEqual(
            {name: versions[name] for name in crates},
            {name: "9.8.7" for name in crates},
        )
        self.assertEqual(versions["fixture-external"], "2.3.4")

    def test_bump_refuses_non_version_cargo_manifest_content(self):
        self.scenario["cargo_manifest_content"] = True
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI reuse refuses non-version manifest change: crates/mc-module/Cargo.toml", run.stderr)
        self.assert_no_publish()

    def test_bump_refuses_non_version_cargo_lock_content(self):
        self.scenario["cargo_lock_content"] = True
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI reuse refuses non-version Cargo.lock change", run.stderr)
        self.assert_no_publish()

    def test_committed_bump_is_rechecked_before_tag(self):
        self.scenario["amend_source"] = True
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI reuse refuses non-version/notes change: source.ts", run.stderr)
        self.assertNotEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assert_no_publish()

    def test_non_exact_head_runs_local_gates(self):
        (self.repo / "source.ts").write_text("new uncertified code\n")
        self.git("add", ".")
        self.git("commit", "-m", "Fixture untested change")
        run = self.run_script()
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("running all local gates instead", run.stdout)
        self.assertTrue(any(args[-1] == "lint" for args in self.commands("bun")))
        self.assertFalse(self.commands("gh"))
        self.assert_no_publish()

    def test_notes_and_changelog_are_required(self):
        for path in ("CHANGELOG.md", ".cortexkit/release-notes/v9.8.7.md"):
            with self.subTest(path=path):
                original = (self.repo / path).read_text()
                (self.repo / path).write_text("")
                self.git("add", ".")
                self.git("commit", "-m", "Fixture empty notes")
                self.base = self.git("rev-parse", "HEAD").strip()
                self.scenario["base"] = self.base
                run = self.run_script()
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(path, run.stdout)
                self.assert_no_publish()
                (self.repo / path).write_text(original)
                self.git("add", ".")
                self.git("commit", "-m", "Fixture restore notes")


if __name__ == "__main__":
    unittest.main()
