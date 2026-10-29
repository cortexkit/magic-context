#!/usr/bin/env python3
"""Focused tests for exact-run selection and bounded, fail-fast CI waits."""

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("ci_gate", Path(__file__).with_name("ci-gate.py"))
assert spec and spec.loader
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = "a" * 40
SLOW_JOBS = [{"name": f"Slow unit ({mode})", "status": "completed", "conclusion": "success"}
             for mode in ("normal", "assertions")]


class GateTests(unittest.TestCase):
    def test_latest_run_excludes_wrong_sha_branch_event_and_name(self):
        good = {"id": 1, "name": "CI", "head_sha": SHA, "head_branch": "train/check-pr-123", "event": "push"}
        runs = [good, dict(good, id=2), dict(good, id=3, head_sha="b" * 40),
                dict(good, id=4, head_branch="master"), dict(good, id=5, event="pull_request"),
                dict(good, id=6, name="Smoke")]
        with patch.object(gate, "inventory", return_value=runs):
            self.assertEqual(gate.latest_run(SHA, "CI", "train/check-pr-123"), dict(good, id=2))

    def test_failed_job_on_later_page_is_not_hidden(self):
        pages = '[{"jobs": []}, {"jobs": [{"name": "late job", "conclusion": "failure"}]}]'
        with patch.object(gate.subprocess, "run") as command:
            command.return_value.stdout = pages
            self.assertEqual(gate.inventory("actions/runs/1/jobs?per_page=100", "jobs"),
                             [{"name": "late job", "conclusion": "failure"}])
            self.assertIn("--paginate", command.call_args.args[0])

    def test_missing_run_times_out_instead_of_passing(self):
        now = [0]
        with patch.object(gate, "latest_run", return_value=None), \
                patch.object(gate.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(gate.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
            with self.assertRaisesRegex(RuntimeError, "timed out after 23s"):
                gate.wait_ci(SHA, "train/check-pr-123", 23, 10)
        self.assertEqual(now[0], 23)

    def test_unsuccessful_run_refuses_even_without_failed_job(self):
        for conclusion in ("failure", "cancelled", "timed_out", "skipped", "neutral", None):
            with self.subTest(conclusion=conclusion), \
                    patch.object(gate, "latest_run", return_value={"id": 1, "status": "completed", "conclusion": conclusion}), \
                    patch.object(gate, "inventory", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "CI run 1:"):
                    gate.wait_ci(SHA, "train/check-pr-123", 23, 10)

    def test_unsuccessful_job_fails_before_run_completes(self):
        for conclusion in ("failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"):
            with self.subTest(conclusion=conclusion), \
                    patch.object(gate, "latest_run", return_value={"id": 1, "status": "in_progress"}), \
                    patch.object(gate, "inventory", return_value=[{"name": "broken job", "conclusion": conclusion}]):
                with self.assertRaisesRegex(RuntimeError, f"CI job broken job: {conclusion}"):
                    gate.wait_ci(SHA, "train/check-pr-123", 23, 10)

    def test_latest_slow_run_ignores_fast_master_but_not_newer_failed_candidate(self):
        candidate = {"id": 1, "name": "CI", "head_sha": SHA, "head_branch": "train/check-pr-123", "event": "push"}
        runs = [candidate, dict(candidate, id=3, head_branch="master"),
                dict(candidate, id=2, conclusion="failure"), dict(candidate, id=4, head_sha="b" * 40)]
        with patch.object(gate, "inventory", return_value=runs):
            self.assertEqual(gate.latest_run(SHA, "CI", slow_only=True), dict(candidate, id=2, conclusion="failure"))

    def test_check_branch_success_requires_both_slow_modes(self):
        for jobs in ([], SLOW_JOBS[:1], [dict(job, conclusion="skipped") for job in SLOW_JOBS]):
            with self.subTest(jobs=jobs), \
                    patch.object(gate, "latest_run", return_value={"id": 1, "status": "completed", "conclusion": "success"}), \
                    patch.object(gate, "inventory", return_value=jobs):
                with self.assertRaisesRegex(RuntimeError, "required slow lane"):
                    gate.wait_ci(SHA, "train/check-pr-123", 23, 10)
        with patch.object(gate, "latest_run", return_value={"id": 1, "status": "completed", "conclusion": "success"}), \
                patch.object(gate, "inventory", return_value=SLOW_JOBS):
            gate.wait_ci(SHA, "train/check-pr-123", 23, 10)


GREEN = {"id": 7, "name": "CI", "head_sha": SHA, "head_branch": "train/check-pr-123",
         "event": "push", "status": "completed", "conclusion": "success"}
SMOKE = dict(GREEN, id=8, name="Smoke (opencode bring-up on Linux)")


class ReleaseEvidenceTests(unittest.TestCase):
    def verify(self, runs):
        def inventory(route, key):
            return runs if key == "workflow_runs" else SLOW_JOBS

        with patch.object(gate, "inventory", side_effect=inventory):
            gate.verify_release(SHA, sleep=lambda seconds: None)

    def test_green_check_run_survives_queued_push_and_in_progress_schedule(self):
        runs = [GREEN, SMOKE,
                dict(GREEN, id=9, head_branch="master", status="queued", conclusion=None),
                dict(GREEN, id=10, head_branch="master", event="schedule",
                     status="in_progress", conclusion=None),
                dict(SMOKE, id=11, status="queued", conclusion=None)]
        self.verify(runs)

    def test_completed_failure_vetoes_success_for_each_workflow_regardless_of_order(self):
        for workflow in (GREEN, SMOKE):
            for conclusion in ("failure", "timed_out", "startup_failure", "action_required", "stale"):
                for run_id in (1, 9):
                    with self.subTest(workflow=workflow["name"], conclusion=conclusion, run_id=run_id):
                        failed = dict(workflow, id=run_id, conclusion=conclusion)
                        name = "CI" if workflow is GREEN else "Smoke"
                        with self.assertRaisesRegex(RuntimeError, f"{name} for {SHA}: completed/{conclusion}"):
                            self.verify([GREEN, SMOKE, failed])

    def test_missing_smoke_run_refuses(self):
        with self.assertRaisesRegex(RuntimeError, f"Smoke for {SHA}: missing"):
            self.verify([GREEN])

    def test_only_cancelled_run_refuses(self):
        for workflow in (GREEN, SMOKE):
            with self.subTest(workflow=workflow["name"]):
                runs = [dict(run, conclusion="cancelled") if run is workflow else run
                        for run in (GREEN, SMOKE)]
                name = "CI" if workflow is GREEN else "Smoke"
                with self.assertRaisesRegex(RuntimeError, f"{name} for {SHA}: completed/cancelled"):
                    self.verify(runs)

    def test_cancelled_reruns_do_not_veto_success(self):
        self.verify([GREEN, SMOKE, dict(GREEN, id=9, conclusion="cancelled"),
                     dict(SMOKE, id=10, conclusion="cancelled")])

    def test_other_sha_runs_neither_veto_nor_certify(self):
        other_failures = [dict(run, id=int(run["id"]) + 10, head_sha="b" * 40, conclusion="failure")
                          for run in (GREEN, SMOKE)]
        self.verify([GREEN, SMOKE] + other_failures)
        with self.assertRaisesRegex(RuntimeError, f"Smoke for {SHA}: missing"):
            self.verify([GREEN, dict(SMOKE, head_sha="b" * 40)])


class ReleaseRetryTests(unittest.TestCase):
    """verify_release looks again for a run GitHub's list has not shown yet, and only for that."""

    def verify(self, lookups):
        calls = []
        sleeps = []

        def matching_runs(sha, name):
            calls.append(name)
            run = lookups(name, calls.count(name))
            return [run] if run else []

        with patch.object(gate, "matching_runs", side_effect=matching_runs), \
                patch.object(gate, "inventory", return_value=SLOW_JOBS), \
                patch.dict(gate.os.environ, {}, clear=False):
            gate.os.environ.pop("CI_GATE_MISSING_RUN_RETRY_SECONDS", None)
            try:
                gate.verify_release(SHA, sleep=sleeps.append)
                error = None
            except RuntimeError as raised:
                error = raised
        return calls, sleeps, error

    def test_run_missing_on_first_lookup_and_green_on_second_passes(self):
        calls, sleeps, error = self.verify(
            lambda name, attempt: None if name == "Smoke" and attempt == 1 else GREEN)
        self.assertIsNone(error)
        self.assertEqual(calls, ["CI", "Smoke", "Smoke"])
        self.assertEqual(sleeps, [15])

    def test_run_missing_every_time_refuses_after_the_retries(self):
        calls, sleeps, error = self.verify(lambda name, attempt: None if name == "Smoke" else GREEN)
        self.assertIsNotNone(error)
        self.assertIn(f"Smoke for {SHA}: missing, not completed/success", str(error))
        self.assertEqual(calls, ["CI"] + ["Smoke"] * 5)
        self.assertEqual(sleeps, [15] * 4)

    def test_present_but_unsuccessful_run_refuses_without_retry(self):
        for status, conclusion in (("completed", "failure"), ("completed", "cancelled"), ("in_progress", None)):
            with self.subTest(status=status, conclusion=conclusion):
                run = {"id": 8, "status": status, "conclusion": conclusion}
                calls, sleeps, error = self.verify(lambda name, attempt: run if name == "CI" else GREEN)
                self.assertIsNotNone(error)
                self.assertIn(f"CI for {SHA}: {status}/{conclusion}, not completed/success", str(error))
                self.assertEqual(calls, ["CI"])
                self.assertEqual(sleeps, [])

    def test_release_refuses_skipped_missing_or_failed_slow_mode(self):
        for jobs in ([], SLOW_JOBS[:1], [dict(job, conclusion="failure") for job in SLOW_JOBS],
                     [dict(job, conclusion="skipped") for job in SLOW_JOBS]):
            with self.subTest(jobs=jobs), patch.object(gate, "matching_runs", return_value=[GREEN]), \
                    patch.object(gate, "inventory", return_value=jobs):
                with self.assertRaisesRegex(RuntimeError, "required slow lane"):
                    gate.verify_release(SHA)


if __name__ == "__main__":
    unittest.main()
