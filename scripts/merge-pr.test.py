#!/usr/bin/env python3
"""Exercise the real shell gate in disposable repos; API and runners are shims.

Run: timeout 180s python3 scripts/merge-pr.test.py -v
No GitHub calls or changes to the real checkout are made by this suite.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
from typing import Any
import unittest

SCRIPT = Path(__file__).with_name("merge-pr.sh").resolve()
SHIM = SCRIPT.with_name("merge-pr-test-fixtures") / "command-shim.py"
WORKFLOW = SCRIPT.parent.parent / ".github/workflows/review-findings.yml"
REAL_GIT = shutil.which("git")
assert REAL_GIT is not None, "The isolated merge tests require git"


def thread(author="cubic-dev-ai", resolved=False, body="<!-- hidden\nmetadata -->\nImportant finding\nMore detail"):
    return {
        "isResolved": resolved,
        "path": "packages/plugin/src/hooks/magic-context/read-session-chunk.ts",
        "line": 42,
        "originalLine": 40,
        "comments": {"nodes": [{"author": {"login": author}, "body": body, "url": "https://github.com/cortexkit/magic-context/pull/123#discussion_r1"}]},
    }


def workflow_shell():
    return textwrap.dedent(WORKFLOW.read_text().split("        run: |\n", 1)[1])


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="merge-pr-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(TEST_ROOT=str(self.root), REAL_GIT=str(REAL_GIT), TMPDIR=str(self.root / "tmp"),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        PYTHONDONTWRITEBYTECODE="1", HOME=str(self.root / "home"))
        self.git("init", "-b", "master")
        self.git("config", "user.name", "Merge Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        scripts = self.repo / "scripts"
        scripts.mkdir()
        for name in ("check-cortexkit-layout.sh", "check-docs-layout.sh", "check-docs-layout.test.sh"):
            (scripts / name).write_text("#!/bin/sh\necho 'Fixture layout check'\n")
        (self.repo / "README.md").write_text("base\n")
        for package in ("plugin", "pi-plugin", "cli"):
            path = self.repo / "packages" / package
            path.mkdir(parents=True)
            (path / ".keep").write_text("base\n")
            (path / "package.json").write_text("{}\n")
        self.git("add", ".")
        self.git("commit", "-m", "Fixture base")
        self.master = self.git("rev-parse", "HEAD").strip()
        self.scenario: dict[str, Any] = {"master": self.master}
        self.prepare_pr(["packages/plugin/demo.ts"])
        shims = self.root / "shims"
        shims.mkdir()
        # Execute one Python fixture under the command's name. It validates that
        # cwd and every git -C target stay inside this test's temporary tree.
        for name in ("git", "gh", "bun", "bunx", "cargo"):
            path = shims / name
            # Preserve the shim command name without needing executable source.
            path.write_text(f"#!{shutil.which('python3')}\n" + SHIM.read_text().split("\n", 1)[1])
            path.chmod(0o755)
        self.env["PATH"] = str(shims) + os.pathsep + os.environ["PATH"]

    def git(self, *args):
        result = subprocess.run([str(REAL_GIT), *args], cwd=self.repo, env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def prepare_pr(self, paths, message="Fixture PR"):
        self.git("checkout", "-B", "fixture-pr", self.master)
        for name in paths:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("export const changed = true;\n")
        self.git("add", ".")
        self.git("commit", "-m", message)
        self.scenario["head"] = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "master")

    def run_script(self, *args, workflow=False):
        (self.root / "scenario.json").write_text(json.dumps(self.scenario))
        if workflow:
            script = self.root / "workflow.sh"
            script.write_text(workflow_shell())
            env = dict(self.env, PR_NUMBER="123", GITHUB_REPOSITORY="cortexkit/magic-context",
                       GITHUB_STEP_SUMMARY=str(self.root / "summary"))
            command = ["bash", str(script)]
        else:
            env = self.env
            command = ["bash", str(SCRIPT), "123", *args]
        return subprocess.run(command, cwd=self.repo, env=env, capture_output=True, text=True, timeout=30)

    def commands(self, name=None):
        path = self.root / "commands.jsonl"
        entries = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [entry for entry in entries if name is None or entry["name"] == name]

    def assert_no_merge_or_push(self):
        self.assertEqual(self.git("rev-parse", "master").strip(), self.master)
        for entry in self.commands("git"):
            self.assertNotEqual(entry["args"][0], "push")
            if entry["cwd"] == str(self.repo):
                self.assertNotEqual(entry["args"][0], "merge")

    def assert_cleaned(self):
        self.assertFalse((self.root / "tmp/magic-context/merge-pr-123").exists())
        self.assertEqual(len(self.git("worktree", "list", "--porcelain").split("worktree ")) - 1, 1)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def assert_refused(self, run, message):
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn(message, run.stderr)
        self.assert_no_merge_or_push()

    def test_unresolved_cubic_thread_refuses(self):
        self.scenario["threads"] = [[thread()]]
        run = self.run_script()
        self.assert_refused(run, "unresolved reviewer-bot findings")
        self.assertIn("cubic-dev-ai packages/plugin/src/hooks/magic-context/read-session-chunk.ts:42: Important finding", run.stdout)
        self.assertIn("#discussion_r1", run.stdout)
        self.assertNotIn("metadata", run.stdout)
        self.assertFalse(self.commands("bun"))

    def test_unresolved_greptile_thread_refuses(self):
        self.scenario["threads"] = [[thread("greptile-apps")]]
        self.assert_refused(self.run_script(), "unresolved reviewer-bot findings")

    def test_bot_suffix_spelling_refuses(self):
        self.scenario["threads"] = [[thread("cubic-dev-ai[bot]"), thread("greptile-apps[bot]")]]
        run = self.run_script()
        self.assert_refused(run, "unresolved reviewer-bot findings")
        self.assertIn("greptile-apps", run.stdout)

    def test_resolved_threads_proceed(self):
        self.scenario["threads"] = [[thread(resolved=True), thread("greptile-apps", resolved=True)]]
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("Dry run passed", run.stdout)
        self.assert_no_merge_or_push()
        self.assert_cleaned()

    def test_human_unresolved_thread_does_not_block(self):
        self.scenario["threads"] = [[thread("human")]]
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_only_first_comment_author_controls_gate(self):
        item = thread("human")
        item["comments"]["nodes"].append(thread()["comments"]["nodes"][0])
        self.scenario["threads"] = [[item]]
        self.assertEqual(self.run_script("--findings-only").returncode, 0)

    def test_findings_paginate_past_100(self):
        self.scenario["threads"] = [[thread("human") for _ in range(100)], [thread("greptile-apps")]]
        run = self.run_script()
        self.assert_refused(run, "unresolved reviewer-bot findings")
        self.assertIn("greptile-apps", run.stdout)
        self.assertEqual(len(self.commands("gh")), 2)
        self.assertIn("cursor=page-1", self.commands("gh")[1]["args"])

    def test_all_unresolved_threads_are_listed_even_across_pages(self):
        self.scenario["threads"] = [[thread()], [thread("greptile-apps")]]
        run = self.run_script("--findings-only")
        self.assert_refused(run, "unresolved reviewer-bot findings")
        self.assertIn("cubic-dev-ai", run.stdout)
        self.assertIn("greptile-apps", run.stdout)

    def test_outdated_thread_uses_original_line(self):
        item = thread()
        item["line"] = None
        self.scenario["threads"] = [[item]]
        run = self.run_script()
        self.assert_refused(run, "unresolved reviewer-bot findings")
        self.assertIn(":40: Important finding", run.stdout)

    def test_pending_bot_checks_refuse(self):
        for app in ("cubic-dev-ai", "greptile-apps"):
            for status in ("queued", "in_progress"):
                with self.subTest(app=app, status=status):
                    self.scenario["check_pages"] = [{"check_runs": [{"app": {"slug": app}, "name": "Review", "status": status}]}]
                    self.assert_refused(self.run_script(), "checks are still running")

    def test_check_runs_paginate(self):
        self.scenario["check_pages"] = [{"check_runs": []}, {"check_runs": [{"app": {"slug": "greptile-apps"}, "name": "Review", "status": "queued"}]}]
        self.assert_refused(self.run_script(), "checks are still running")

    def test_completed_bot_and_pending_other_checks_do_not_block(self):
        self.scenario["check_pages"] = [{"check_runs": [
            {"app": {"slug": "cubic-dev-ai"}, "name": "Review", "status": "completed"},
            {"app": {"slug": "human-ci"}, "name": "Build", "status": "queued"},
        ]}]
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_closing_keyword_in_title_refuses(self):
        for title in ("Fix #123", "fiXes #42", "Close #42", "closes #123", "Resolve #123", "RESOLVES #99", "fixed #42", "closed #42", "resolved #42"):
            with self.subTest(title=title):
                self.scenario["title"] = title
                self.assert_refused(self.run_script(), "closing keyword")

    def test_closing_keyword_in_description_refuses(self):
        for body in ("Summary.\n\nFixes #777", "fixes: #7", "Closes cortexkit/magic-context#9"):
            with self.subTest(body=body):
                self.scenario["body"] = body
                self.assert_refused(self.run_script(), "PR description contains a GitHub closing keyword")

    def test_closing_keyword_in_commit_message_refuses(self):
        self.prepare_pr(["packages/plugin/demo.ts"], message="fix(agents): keep named allows\n\nFixes #777")
        run = self.run_script()
        self.assert_refused(run, "commit message in PR #123 contains a GitHub closing keyword")
        self.assertIn("Fixes #777", run.stderr)

    def test_issue_mentions_without_closing_keyword_proceed(self):
        self.scenario["body"] = "Implements the direction agreed in issue #777 (see #777)."
        self.prepare_pr(["packages/plugin/demo.ts"], message="fix(agents): keep named allows (#777)")
        self.assertEqual(self.run_script().returncode, 0)

    def test_rechecks_description_after_gates(self):
        self.scenario["recheck"] = {"body": "Fixes #123"}
        self.assert_refused(self.run_script(), "PR description contains a GitHub closing keyword")

    def test_head_changed_between_query_and_fetch_refuses(self):
        self.scenario["fetched_head"] = self.master
        self.assert_refused(self.run_script(), "head changed between")
        self.assertFalse(self.commands("bun"))

    def test_failing_gate_never_merges_or_pushes(self):
        self.scenario["fail_runner"] = "bun run test"
        self.assert_refused(self.run_script(), "Command failed (exit 7): bun run test")
        self.assert_cleaned()

    def test_timeout_never_merges_or_pushes(self):
        self.scenario.update(fail_runner="bun run test", runner_status=124)
        self.assert_refused(self.run_script(), "Command failed (exit 124)")
        self.assert_cleaned()

    def test_install_failure_never_merges_or_pushes(self):
        self.scenario["fail_runner"] = "bun install --frozen-lockfile"
        self.assert_refused(self.run_script(), "Command failed (exit 7)")
        self.assertFalse(any(item["args"] == ["run", "test"] for item in self.commands("bun")))

    def test_typecheck_failure_never_merges_or_pushes(self):
        self.scenario["fail_runner"] = "bun run typecheck"
        self.assert_refused(self.run_script(), "Command failed (exit 7)")

    def test_biome_failure_never_merges_or_pushes(self):
        self.scenario["fail_runner"] = "bunx biome check --no-errors-on-unmatched ./packages/plugin/demo.ts"
        self.assert_refused(self.run_script(), "Command failed (exit 7)")

    def test_package_scoped_gates_and_quoted_paths(self):
        paths = ["packages/plugin/a.ts", "packages/pi-plugin/b.ts", "packages/cli/c.ts", "crates/example/lib.rs", "docs/file with spaces.md", "-option.ts"]
        self.prepare_pr(paths)
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        commands = self.commands("bun")
        self.assertEqual([(Path(item["cwd"]).name, item["args"]) for item in commands], [
            ("merge-pr-123", ["install", "--frozen-lockfile"]),
            ("merge-pr-123", ["run", "build:dists"]),
            ("plugin", ["run", "test"]), ("plugin", ["run", "typecheck"]), ("plugin", ["run", "lint"]),
            ("pi-plugin", ["run", "test"]), ("pi-plugin", ["run", "typecheck"]), ("pi-plugin", ["run", "lint"]),
            ("cli", ["run", "test"]), ("cli", ["run", "lint"]),
        ])
        self.assertEqual([item["args"] for item in self.commands("cargo")], [["clippy", "--workspace", "--", "-D", "warnings"], ["test", "--workspace"]])
        self.assertEqual(self.commands("bunx")[0]["args"], ["biome", "check", "--no-errors-on-unmatched", *["./" + path for path in sorted(paths)]])
        self.assert_cleaned()

    def test_plugin_only_runs_dependent_package_gates(self):
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual([(Path(item["cwd"]).name, item["args"]) for item in self.commands("bun")], [
            ("merge-pr-123", ["install", "--frozen-lockfile"]),
            ("merge-pr-123", ["run", "build:dists"]),
            ("plugin", ["run", "test"]), ("plugin", ["run", "typecheck"]), ("plugin", ["run", "lint"]),
            ("pi-plugin", ["run", "test"]), ("pi-plugin", ["run", "typecheck"]), ("pi-plugin", ["run", "lint"]),
            ("cli", ["run", "test"]), ("cli", ["run", "lint"]),
        ])
        self.assertFalse(self.commands("cargo"))
        self.assert_cleaned()

    def test_e2e_changes_run_mode_manifest_gate(self):
        self.prepare_pr(["packages/e2e-tests/scripts/validate-mode-manifest.test.ts"])
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual([(Path(item["cwd"]).name, item["args"]) for item in self.commands("bun")], [
            ("merge-pr-123", ["install", "--frozen-lockfile"]),
            ("merge-pr-123", ["run", "build:dists"]),
            ("e2e-tests", ["test", "scripts/validate-mode-manifest.test.ts"]),
        ])
        self.assertFalse(self.commands("cargo"))
        self.assert_cleaned()

    def test_unrelated_paths_only_install_build_and_biome(self):
        self.prepare_pr(["docs/example.md"])
        run = self.run_script("--dry-run")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual([item["args"] for item in self.commands("bun")], [["install", "--frozen-lockfile"], ["run", "build:dists"]])
        self.assertFalse(self.commands("cargo"))
        self.assertEqual(len(self.commands("bunx")), 1)

    def test_deleted_paths_select_package_gate_but_are_not_linted(self):
        self.git("checkout", "fixture-pr")
        self.git("rm", "packages/plugin/.keep", "packages/plugin/demo.ts")
        self.git("commit", "-m", "Fixture deletion")
        self.scenario["head"] = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "master")
        run = self.run_script("--dry-run")
        # Leave the package directory present, as a real package deletion has
        # other files. A single deleted fixture file is enough to select tests.
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("no surviving changed files", run.stdout)
        self.assertFalse(self.commands("bunx"))
        self.assertTrue(any(item["args"] == ["run", "test"] for item in self.commands("bun")))

    def test_open_master_required(self):
        self.scenario["state"] = "MERGED"
        self.assert_refused(self.run_script(), "open and target master")
        self.scenario.update(state="OPEN", base="develop")
        self.assert_refused(self.run_script(), "open and target master")

    def test_findings_only_works_for_merged_and_closed_prs(self):
        for state in ("MERGED", "CLOSED"):
            with self.subTest(state=state):
                self.scenario.update(state=state, base="other")
                run = self.run_script("--findings-only")
                self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse(self.commands("git"))
        self.assertFalse(self.commands("bun"))

    def test_findings_only_merged_unresolved_refuses(self):
        self.scenario.update(state="MERGED", threads=[[thread()]])
        self.assert_refused(self.run_script("--findings-only"), "unresolved reviewer-bot findings")

    def test_dirty_worktree_refuses(self):
        (self.repo / "untracked").write_text("local data")
        self.assert_refused(self.run_script(), "Working tree is dirty")

    def test_not_master_refuses(self):
        self.git("checkout", "fixture-pr")
        self.assert_refused(self.run_script(), "master branch")

    def test_local_master_behind_origin_refuses(self):
        self.scenario["origin_master"] = self.scenario["head"]
        self.assert_refused(self.run_script(), "behind or diverged")

    def test_existing_temporary_worktree_is_not_removed(self):
        path = self.root / "tmp/magic-context/merge-pr-123"
        path.mkdir(parents=True)
        (path / "sentinel").write_text("owned by someone else")
        self.assert_refused(self.run_script(), "already exists")
        self.assertEqual((path / "sentinel").read_text(), "owned by someone else")

    def test_trial_merge_conflict_refuses(self):
        (self.repo / "packages/plugin/demo.ts").write_text("local conflicting change\n")
        self.git("add", ".")
        self.git("commit", "-m", "Fixture conflicting master")
        self.master = self.git("rev-parse", "HEAD").strip()
        self.scenario["master"] = self.master
        self.assert_refused(self.run_script(), "Command failed (exit 1): git -C")
        self.assert_cleaned()

    def test_api_failure_refuses(self):
        self.scenario["api_failure"] = True
        self.assert_refused(self.run_script(), "GraphQL query failed (gh exit 9)")

    def test_shim_graphql_refusal_is_explained(self):
        self.scenario["shim_refusal"] = True
        run = self.run_script("--findings-only")
        self.assert_refused(run, "AFT gh shim refused this read-only GraphQL query")
        self.assertIn("manifest", run.stderr)
        self.assertFalse(self.commands("git"))

    def test_graphql_errors_and_missing_pr_refuse(self):
        self.scenario["graphql_errors"] = True
        self.assert_refused(self.run_script(), "Command failed")
        self.scenario.update(graphql_errors=False, missing_pr=True)
        self.assert_refused(self.run_script(), "Command failed")

    def test_success_merges_exact_head_pushes_and_quotes_title(self):
        run = self.run_script()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(self.git("rev-parse", "master^2").strip(), self.scenario["head"])
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), 'Merge PR #123: A safe "quoted" title; $(touch SHOULD_NOT_EXIST)')
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())
        self.assertEqual([item["args"] for item in self.commands("git") if item["args"][0] == "push"], [["push", "origin", "master"]])
        self.assert_cleaned()

    def test_ci_gate_refuses_unresolved_threads(self):
        for author in ("cubic-dev-ai", "greptile-apps"):
            with self.subTest(author=author):
                self.scenario["threads"] = [[thread(author)]]
                self.assert_refused(self.run_script("--ci-gate"), "unresolved reviewer-bot findings")

    def test_ci_gate_preserves_running_bot_and_title_refusals(self):
        self.scenario["check_pages"] = [{"check_runs": [{"app": {"slug": "greptile-apps"}, "name": "Review", "status": "queued"}]}]
        self.assert_refused(self.run_script("--ci-gate"), "checks are still running")
        self.scenario["check_pages"] = [{"check_runs": []}]
        self.scenario["title"] = "Fix #123"
        self.assert_refused(self.run_script("--ci-gate"), "closing keyword")

    def test_ci_gate_failed_job_stops_before_master_even_while_run_in_progress(self):
        self.scenario["failed_job"] = True
        run = self.run_script("--ci-gate")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("CI job Rust shard: failure", run.stderr)
        self.assertEqual(self.git("rev-parse", "master").strip(), self.master)
        pushes = [item["args"] for item in self.commands("git") if item["args"][0] == "push"]
        self.assertEqual(len(pushes), 1)
        self.assertTrue(pushes[0][-1].endswith(":refs/heads/train/check-pr-123"))
        self.assertFalse(self.commands("bun"))
        self.assert_cleaned()

    def test_ci_gate_missing_slow_modes_never_fast_forwards_master(self):
        self.scenario["ci_jobs"] = []
        run = self.run_script("--ci-gate")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("required slow lane", run.stderr)
        self.assertEqual(self.git("rev-parse", "master").strip(), self.master)
        pushes = [item["args"] for item in self.commands("git") if item["args"][0] == "push"]
        self.assertEqual(len(pushes), 1)
        self.assertTrue(pushes[0][-1].endswith(":refs/heads/train/check-pr-123"))
        self.assert_cleaned()

    def test_ci_gate_fast_forwards_only_the_tested_sha(self):
        run = self.run_script("--ci-gate")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        pushes = [item["args"] for item in self.commands("git") if item["args"][0] == "push"]
        self.assertEqual(len(pushes), 2)
        tested = pushes[0][-1].split(":")[0]
        self.assertEqual(pushes[1], ["push", "origin", tested + ":refs/heads/master"])
        self.assertEqual(self.git("rev-parse", "master").strip(), tested)
        self.assertEqual(self.git("rev-parse", "master^2").strip(), self.scenario["head"])
        merges = [item["args"] for item in self.commands("git") if item["cwd"] == str(self.repo) and item["args"][0] == "merge"]
        self.assertEqual(merges, [["merge", "--ff-only", tested]])
        self.assertIn("completed/success for " + tested, run.stdout)
        self.assertFalse(self.commands("bun"))
        self.assertFalse(self.commands("cargo"))
        self.assertFalse(self.commands("bunx"))
        self.assert_cleaned()

    def test_ci_gate_dry_run_never_pushes(self):
        run = self.run_script("--ci-gate", "--dry-run")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("Would push", run.stdout)
        self.assert_no_merge_or_push()
        self.assert_cleaned()

    def test_ci_gate_rechecks_pr_head_before_fast_forward(self):
        self.scenario["recheck"] = {"headRefOid": self.master}
        run = self.run_script("--ci-gate")
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("head changed during verification", run.stderr)
        self.assertEqual(self.git("rev-parse", "master").strip(), self.master)
        self.assertEqual(len([item for item in self.commands("git") if item["args"][0] == "push"]), 1)
        self.assert_cleaned()

    def test_rechecks_head_after_gates(self):
        self.scenario["recheck"] = {"headRefOid": self.master}
        self.assert_refused(self.run_script(), "head changed during verification")

    def test_rechecks_findings_after_gates(self):
        self.scenario["recheck"] = {"reviewThreads": {"nodes": [thread()], "pageInfo": {"hasNextPage": False, "endCursor": None}}}
        self.assert_refused(self.run_script(), "unresolved reviewer-bot findings")
        self.assertTrue(any(item["args"] == ["run", "test"] for item in self.commands("bun")))

    def test_rechecks_title_after_gates(self):
        self.scenario["recheck"] = {"title": "Fix #123"}
        self.assert_refused(self.run_script(), "closing keyword")

    def test_workflow_lists_paginated_findings_in_summary(self):
        self.scenario["threads"] = [[thread("human") for _ in range(100)], [thread("greptile-apps[bot]", body="Unsafe <b>markup</b>\nDetails")]]
        run = self.run_script(workflow=True)
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        summary = (self.root / "summary").read_text()
        self.assertIn("greptile-apps", summary)
        self.assertIn("#discussion_r1", summary)
        self.assertIn("Unsafe &lt;b&gt;markup&lt;/b&gt;", summary)
        self.assertFalse(self.commands("git"))
        self.assertFalse(self.commands("bun"))

    def test_workflow_resolved_threads_succeed(self):
        self.scenario["threads"] = [[thread(resolved=True), thread("greptile-apps", resolved=True), thread("human")]]
        run = self.run_script(workflow=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("No unresolved reviewer-bot findings", (self.root / "summary").read_text())

    def test_workflow_api_failure_fails_closed(self):
        self.scenario["graphql_errors"] = True
        self.assertNotEqual(self.run_script(workflow=True).returncode, 0)

    def test_workflow_and_local_gate_share_query_and_filter(self):
        script = SCRIPT.read_text()
        workflow = workflow_shell()
        for variable in ("REVIEW_BOTS", "QUERY", "VALID_PAGE", "FINDINGS_FILTER"):
            pattern = re.compile(r"^\s*" + variable + r"='(.*?)'", re.MULTILINE | re.DOTALL)
            local = pattern.search(script)
            visible = pattern.search(workflow)
            self.assertIsNotNone(local, variable)
            self.assertIsNotNone(visible, variable)
            assert local is not None and visible is not None
            self.assertEqual(re.sub(r"\s+", " ", local.group(1)), re.sub(r"\s+", " ", visible.group(1)), variable)


if __name__ == "__main__":
    unittest.main()
