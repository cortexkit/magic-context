#!/usr/bin/env python3
"""Wait for a same-attempt artifact, stopping on a terminal producer or bounded deadline."""

import argparse
import errno
import http.client
import json
import os
import socket
import sys
import time
import unittest
from datetime import datetime, timezone
from email.message import Message
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


QUEUE_ALLOWANCE_SECONDS = 30 * 60
ARTIFACT_PROPAGATION_GRACE_SECONDS = 60
# Pauses between retries of a transient API error; the last one repeats. The
# script already waits up to its total cap for the producer, so a GitHub API
# outage of a few minutes (502s for minutes at a time on 2026-11-12) is
# waited out under that cap instead of failing the consuming job.
TRANSIENT_RETRY_DELAYS = (1, 2, 4, 8, 16, 30)


def _timestamp(value, producer):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{producer}: invalid producer timestamp {value!r}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def resolve_max_wait_seconds(producer_timeout, override=None):
    if override is None:
        return producer_timeout + QUEUE_ALLOWANCE_SECONDS
    if override < producer_timeout:
        raise ValueError("maximum wait override cannot be less than producer timeout")
    return override


def wait_for_artifact(
    fetch,
    producer,
    artifact,
    timeout,
    clock=time.monotonic,
    pause=time.sleep,
    max_wait=None,
    wall_clock=time.time,
):
    max_wait = resolve_max_wait_seconds(timeout, max_wait)
    total_deadline = clock() + max_wait
    success_missing_deadline = None
    while True:
        now = clock()
        if success_missing_deadline is not None and now >= success_missing_deadline:
            raise RuntimeError(f"{producer}: producer succeeded without artifact {artifact}")
        if now >= total_deadline:
            raise RuntimeError(f"{producer}: artifact wait timed out after {max_wait:g}s total cap")
        jobs = fetch("jobs")["jobs"]
        matches = [job for job in jobs if job["name"] == producer]
        if len(matches) > 1:
            raise RuntimeError(f"{producer}: ambiguous producer jobs")
        job = matches[0] if matches else None
        if job and job["status"] == "completed" and job["conclusion"] != "success":
            raise RuntimeError(f"{producer}: producer ended {job['conclusion']} without a usable artifact")
        producer_deadline = None
        if job and job["status"] == "in_progress" and job.get("started_at"):
            started_at = _timestamp(job["started_at"], producer)
            producer_deadline = started_at + timeout
            producer_remaining = producer_deadline - wall_clock()
            if producer_remaining <= 0:
                raise RuntimeError(f"{producer}: artifact wait timed out after {timeout:g}s since producer started")
        artifacts = fetch("artifacts")["artifacts"]
        ready = [item for item in artifacts if item["name"] == artifact and not item["expired"]]
        if len(ready) == 1:
            return ready[0]["id"]
        if len(ready) > 1:
            raise RuntimeError(f"{producer}: ambiguous artifact {artifact}")
        if job and job["status"] == "completed":
            if success_missing_deadline is None:
                success_missing_deadline = min(total_deadline, clock() + ARTIFACT_PROPAGATION_GRACE_SECONDS)
            success_remaining = success_missing_deadline - clock()
            if success_remaining <= 0:
                raise RuntimeError(f"{producer}: producer succeeded without artifact {artifact}")
        remaining = total_deadline - clock()
        if producer_deadline is not None:
            remaining = min(remaining, producer_deadline - wall_clock())
        if success_missing_deadline is not None:
            remaining = min(remaining, success_missing_deadline - clock())
        if remaining <= 0:
            if success_missing_deadline is not None and clock() >= success_missing_deadline:
                raise RuntimeError(f"{producer}: producer succeeded without artifact {artifact}")
            if producer_deadline is not None and producer_deadline <= wall_clock():
                raise RuntimeError(f"{producer}: artifact wait timed out after {timeout:g}s since producer started")
            raise RuntimeError(f"{producer}: artifact wait timed out after {max_wait:g}s total cap")
        pause(min(10, remaining))


def _is_transient_api_error(error):
    if isinstance(error, HTTPError):
        return 500 <= error.code < 600
    # The connection dropped while the reply body was being read: GitHub sent
    # the headers, then closed early. A fresh request usually succeeds.
    if isinstance(error, http.client.IncompleteRead):
        return True
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, (TimeoutError, socket.timeout, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return True
    if isinstance(reason, OSError):
        return reason.errno in (errno.ETIMEDOUT, errno.ECONNRESET, errno.ECONNABORTED, errno.EPIPE)
    if isinstance(reason, str):
        message = reason.lower()
        return any(text in message for text in ("timed out", "connection reset", "connection aborted", "broken pipe"))
    return False


def _request_json(request, deadline, clock=time.monotonic, pause=time.sleep, open_url=urlopen):
    retries = 0
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError("artifact API request exceeded the total wait cap")
        try:
            with open_url(request, timeout=max(0.001, min(30, remaining))) as response:
                return json.load(response)
        except Exception as error:
            if not _is_transient_api_error(error):
                raise
            remaining = deadline - clock()
            if remaining <= 0:
                raise
            delay = TRANSIENT_RETRY_DELAYS[min(retries, len(TRANSIENT_RETRY_DELAYS) - 1)]
            pause(min(delay, remaining))
            retries += 1


def producer_for_attempt(current, history, producer):
    matches = [job for job in current if job["name"] == producer]
    if matches:
        return matches
    if any(job["name"] == "Preflight (checks and dists)" for job in current):
        return [{"name": producer, "status": "queued", "conclusion": None}]
    previous = [job for job in history if job["name"] == producer]
    return [max(previous, key=lambda job: job["id"])] if previous else []


def originating_attempt(job, history):
    """Attempt that actually ran this producer execution.

    A failed-only rerun copies successful jobs into the new attempt under a new
    job id and the new run_attempt, but keeps their original started_at. Their
    artifact still carries the attempt that produced it, so follow the copy back
    to the earliest attempt with the same start. A producer that really ran
    again has a new start time and keeps its own attempt.
    """
    started = job.get("started_at")
    attempt = job.get("run_attempt")
    if not started or attempt is None:
        return attempt
    same_run = [
        other["run_attempt"]
        for other in history
        if other["name"] == job["name"] and other.get("started_at") == started and other.get("run_attempt") is not None
    ]
    return min(same_run + [attempt])


class WaitTests(unittest.TestCase):
    def run_wait(self, status="in_progress", conclusion=None, ready=False, timeout=20, max_wait=120, started_at=None):
        now = [0]
        wall = [datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()]
        calls = []

        def fetch(kind):
            calls.append(kind)
            if kind == "jobs":
                job = {"name": "producer", "status": status, "conclusion": conclusion}
                if started_at is not None:
                    job["started_at"] = datetime.fromtimestamp(wall[0] - started_at, timezone.utc).isoformat()
                return {"jobs": [job]}
            return {"artifacts": [{"name": "artifact", "expired": False, "id": 7}] if ready else []}

        def pause(seconds):
            now[0] += seconds
            wall[0] += seconds

        return wait_for_artifact(fetch, "producer", "artifact", timeout, lambda: now[0], pause, max_wait, lambda: wall[0]), now[0], calls

    def test_artifact_ready(self):
        self.assertEqual(self.run_wait(ready=True)[:2], (7, 0))

    def test_producer_failed(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer ended failure"):
            self.run_wait(status="completed", conclusion="failure")

    def test_producer_cancelled(self):
        calls = []

        def fetch(kind):
            calls.append(kind)
            return {"jobs": [{"name": "producer", "status": "completed", "conclusion": "cancelled"}]} if kind == "jobs" else {"artifacts": []}

        with self.assertRaisesRegex(RuntimeError, "producer: producer ended cancelled"):
            wait_for_artifact(fetch, "producer", "artifact", 20, max_wait=120)
        self.assertEqual(calls, ["jobs"])

    def test_producer_timed_out(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer ended timed_out"):
            self.run_wait(status="completed", conclusion="timed_out")

    def test_success_without_artifact(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer succeeded without artifact"):
            self.run_wait(status="completed", conclusion="success")

    def test_wait_timeout(self):
        now = [0]
        fetch = lambda kind: {kind: []}
        with self.assertRaisesRegex(RuntimeError, "producer: artifact wait timed out after 23s total cap"):
            wait_for_artifact(fetch, "producer", "artifact", 20, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds), 23)
        self.assertEqual(now[0], 23)

    def test_queued_producer_at_40_minutes_can_run_60_minutes(self):
        now = [0]
        wall = [datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()]
        queue_duration = 40 * 60
        producer_runtime = 60 * 60

        def fetch(kind):
            if kind == "jobs":
                if now[0] < queue_duration:
                    return {"jobs": [{"name": "producer", "status": "queued", "conclusion": None}]}
                started_at = datetime.fromtimestamp(wall[0] - (now[0] - queue_duration), timezone.utc).isoformat()
                status = "in_progress" if now[0] < queue_duration + producer_runtime else "completed"
                conclusion = None if status == "in_progress" else "success"
                return {"jobs": [{"name": "producer", "status": status, "conclusion": conclusion, "started_at": started_at}]}
            return {"artifacts": [{"name": "artifact", "expired": False, "id": 7}] if now[0] >= queue_duration + producer_runtime else []}

        def pause(seconds):
            now[0] += seconds
            wall[0] += seconds

        artifact_id = wait_for_artifact(fetch, "producer", "artifact", 120 * 60, lambda: now[0], pause, wall_clock=lambda: wall[0])
        self.assertEqual(artifact_id, 7)
        self.assertEqual(now[0], queue_duration + producer_runtime)

    def test_producer_runtime_timeout_starts_at_started_at(self):
        with self.assertRaisesRegex(RuntimeError, "producer: artifact wait timed out after 20s since producer started"):
            self.run_wait(status="in_progress", timeout=20, started_at=21)

    def test_default_total_wait_cap_is_timeout_plus_30_minute_queue_allowance(self):
        now = [0]
        fetch = lambda kind: {"jobs": [{"name": "producer", "status": "queued", "conclusion": None}]} if kind == "jobs" else {"artifacts": []}
        with self.assertRaisesRegex(RuntimeError, "producer: artifact wait timed out after 9000s total cap"):
            wait_for_artifact(fetch, "producer", "artifact", 120 * 60, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds))
        self.assertEqual(now[0], 150 * 60)

    def test_max_wait_override_below_producer_timeout_is_refused(self):
        with self.assertRaisesRegex(ValueError, "maximum wait override cannot be less than producer timeout"):
            resolve_max_wait_seconds(120 * 60, 119 * 60)

    def test_transient_api_errors_are_retried(self):
        import io

        failures = [
            HTTPError("https://example.test", 503, "busy", Message(), None),
            URLError(socket.timeout("timed out")),
            ConnectionResetError("reset"),
            http.client.IncompleteRead(b"", 176166),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                attempts = [0]
                pauses = []

                def open_url(request, timeout):
                    attempts[0] += 1
                    if attempts[0] == 1:
                        raise failure
                    return io.BytesIO(b'{"ok": true}')

                result = _request_json(None, 100, lambda: 0, pauses.append, open_url)
                self.assertEqual(result, {"ok": True})
                self.assertEqual(attempts[0], 2)
                self.assertEqual(pauses, [1])

    def test_a_long_transient_outage_is_waited_out_until_the_total_cap(self):
        import io

        now = [0.0]
        pauses = []
        attempts = [0]

        def pause(seconds):
            pauses.append(seconds)
            now[0] += seconds

        def open_url(request, timeout):
            attempts[0] += 1
            if attempts[0] <= 12:
                raise HTTPError("https://example.test", 502, "bad gateway", Message(), None)
            return io.BytesIO(b'{"ok": true}')

        result = _request_json(None, 1000, lambda: now[0], pause, open_url)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(pauses, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30, 30, 30])

        now[0] = 0.0
        attempts[0] = 0
        pauses.clear()
        # The outage outlasts the cap: the request gives up at the cap, not before.
        with self.assertRaises(TimeoutError):
            _request_json(None, 20, lambda: now[0], pause, open_url)
        self.assertEqual(sum(pauses), 20)

    def test_failed_only_rerun_reuses_the_successful_producers_attempt(self):
        previous = {"id": 1, "name": "producer", "status": "completed", "conclusion": "success", "run_attempt": 1}
        self.assertEqual(producer_for_attempt([], [previous], "producer"), [previous])

    def test_copied_producer_resolves_to_the_attempt_that_ran_it(self):
        original = {"id": 1, "name": "producer", "run_attempt": 1, "started_at": "2026-10-15T04:59:08Z"}
        copy = {"id": 2, "name": "producer", "run_attempt": 2, "started_at": "2026-10-15T04:59:08Z"}
        self.assertEqual(originating_attempt(copy, [original, copy]), 1)

    def test_rerun_producer_keeps_its_own_attempt(self):
        original = {"id": 1, "name": "producer", "run_attempt": 1, "started_at": "2026-10-15T04:59:08Z"}
        rerun = {"id": 2, "name": "producer", "run_attempt": 2, "started_at": "2026-10-15T05:20:00Z"}
        self.assertEqual(originating_attempt(rerun, [original, rerun]), 2)

    def test_rerun_preflight_prevents_consuming_previous_producer_artifacts(self):
        previous = {"id": 1, "name": "producer", "status": "completed", "conclusion": "success", "run_attempt": 1}
        current = [{"name": "Preflight (checks and dists)"}]
        self.assertEqual(producer_for_attempt(current, [previous], "producer")[0]["status"], "queued")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--timeout-minutes", type=float, required=True)
    parser.add_argument("--max-wait-minutes", type=float)
    args = parser.parse_args()
    if not 0 < args.timeout_minutes <= 360:
        parser.error("timeout must be positive and no more than six hours")
    if args.max_wait_minutes is not None and not 0 < args.max_wait_minutes <= 360:
        parser.error("maximum wait must be positive and no more than six hours")
    producer_timeout = args.timeout_minutes * 60
    override = args.max_wait_minutes * 60 if args.max_wait_minutes is not None else None
    try:
        max_wait = resolve_max_wait_seconds(producer_timeout, override)
    except ValueError as error:
        parser.error(str(error))
    base = os.environ["GITHUB_API_URL"] + "/repos/" + os.environ["GITHUB_REPOSITORY"] + "/actions/runs/" + os.environ["GITHUB_RUN_ID"]
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    deadline = time.monotonic() + max_wait
    selected_attempt = [attempt]

    def request_page(route):
        request = Request(base + route, headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            result = _request_json(request, deadline)
        except Exception as error:
            raise RuntimeError(f"{args.producer}: artifact API query failed: {error}") from error
        return result

    def inventory(route, kind):
        first = request_page(route + "per_page=100&page=1")
        items = first[kind]
        for page in range(2, (first["total_count"] + 99) // 100 + 1):
            items.extend(request_page(route + f"per_page=100&page={page}")[kind])
        return items

    def fetch(kind):
        if kind == "jobs":
            current = inventory(f"/attempts/{attempt}/jobs?", "jobs")
            history = []
            if not any(job["name"] in (args.producer, "Preflight (checks and dists)") for job in current):
                history = inventory("/jobs?filter=all&", "jobs")
            matches = producer_for_attempt(current, history, args.producer)
            if matches:
                producer = matches[0]
                if producer.get("status") == "completed" and producer.get("conclusion") == "success":
                    if not history:
                        history = inventory("/jobs?filter=all&", "jobs")
                    selected_attempt[0] = str(originating_attempt(producer, history) or attempt)
                else:
                    selected_attempt[0] = str(producer.get("run_attempt", attempt))
            return {"jobs": matches}
        expected_name = args.artifact + "-" + selected_attempt[0]
        matches = [item for item in inventory("/artifacts?", "artifacts") if item["name"] == expected_name]
        return {"artifacts": [dict(item, name=args.artifact) for item in matches]}

    print(
        f"Waiting for {args.producer}: {args.artifact} (producer runtime {args.timeout_minutes:g} minutes, "
        f"total wait at most {max_wait / 60:g} minutes)",
        flush=True,
    )
    artifact_id = wait_for_artifact(fetch, args.producer, args.artifact, producer_timeout, max_wait=max_wait)
    print(f"{args.producer}: artifact {artifact_id} ready", flush=True)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"artifact-id={artifact_id}\n")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    else:
        try:
            main()
        except Exception as error:
            sys.exit(str(error))
