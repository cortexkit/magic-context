#!/usr/bin/env python3
"""Read-only API fixtures and remote-only git shims for isolated merge tests."""
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

root = Path(os.environ["TEST_ROOT"]).resolve()
cwd = Path.cwd().resolve()
if root not in (cwd, *cwd.parents):
    sys.exit("Shim refused a command outside the isolated test directory")
scenario = json.loads((root / "scenario.json").read_text())
log_path = root / "commands.jsonl"
previous = [json.loads(line) for line in log_path.read_text().splitlines()] if log_path.exists() else []
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with log_path.open("a") as log:
    log.write(json.dumps({"name": name, "args": args, "cwd": str(cwd)}) + "\n")


def real_git(*command):
    return subprocess.call([os.environ["REAL_GIT"], *command], cwd=cwd)


if name == "gh":
    if scenario.get("shim_refusal"):
        print('gh-shim: gh_shim_unclassified: verb "api" is not declared in manifest', file=sys.stderr)
        sys.exit(86)
    if scenario.get("api_failure"):
        sys.exit(9)
    if args[:2] == ["api", "graphql"]:
        fields = dict(arg.split("=", 1) for arg in args if "=" in arg)
        if fields.get("owner") != "cortexkit" or fields.get("repo") != "magic-context" or fields.get("number") != "123":
            sys.exit("Unexpected GraphQL variables")
        query = fields["query"]
        for fragment in ("headRefOid", "isCrossRepository", "state", "baseRefName", "reviewThreads(first:100, after:$cursor)", "comments(first:1)"):
            if fragment not in query:
                sys.exit("Query missing required field: " + fragment)
        index = int(fields.get("cursor", "page-0").split("-")[-1])
        pages = scenario.get("threads", [[]])
        pr = {
            "number": 123,
            "headRefOid": scenario["head"],
            "isCrossRepository": True,
            "state": scenario.get("state", "OPEN"),
            "baseRefName": scenario.get("base", "master"),
            "title": scenario.get("title", 'A safe "quoted" title; $(touch SHOULD_NOT_EXIST)'),
            "reviewThreads": {
                "nodes": pages[index],
                "pageInfo": {"hasNextPage": index + 1 < len(pages), "endCursor": "page-" + str(index + 1)},
            },
        }
        prior_queries = sum(item["name"] == "gh" and item["args"][:2] == ["api", "graphql"] for item in previous)
        if prior_queries and "recheck" in scenario:
            pr.update(scenario["recheck"])
        if scenario.get("missing_pr"):
            pr = None
        response: dict[str, Any] = {"data": {"repository": {"pullRequest": pr}}}
        if scenario.get("graphql_errors"):
            response["errors"] = [{"message": "fixture GraphQL failure"}]
        print(json.dumps(response))
    elif args == ["api", "repos/cortexkit/magic-context/pulls/123"]:
        prior = sum(item["name"] == "gh" and item["args"] == args for item in previous)
        body = scenario.get("body", "A plain description.")
        if prior and "body" in scenario.get("recheck", {}):
            body = scenario["recheck"]["body"]
        print(json.dumps({"number": 123, "body": body}))
    elif args[:1] == ["api"] and any("/check-runs?per_page=100" in arg for arg in args):
        if "--paginate" not in args or "--slurp" not in args or not any(scenario["head"] in arg for arg in args):
            sys.exit("Check-runs query must paginate the exact head")
        print(json.dumps(scenario.get("check_pages", [{"check_runs": []}])))
    elif args[:1] == ["api"] and any("/actions/runs?head_sha=" in arg for arg in args):
        pushes = [entry for entry in previous if entry["name"] == "git" and entry["args"][:2] == ["push", "--force"]]
        if not pushes or "--paginate" not in args or "--slurp" not in args:
            sys.exit("CI query must follow the trial push and paginate")
        trial = pushes[-1]["args"][-1].split(":")[0]
        if not any(f"head_sha={trial}" in arg for arg in args):
            sys.exit("CI query must use the pushed SHA")
        print(json.dumps([{"workflow_runs": [{
            "id": 321, "name": "CI", "head_sha": scenario.get("ci_sha", trial),
            "head_branch": "train/check-pr-123", "event": "push",
            "status": "in_progress" if scenario.get("failed_job") else "completed",
            "conclusion": None if scenario.get("failed_job") else "success",
        }]}]))
    elif args[:1] == ["api"] and any("/actions/runs/321/jobs?" in arg for arg in args):
        jobs = [{"name": "Rust shard", "status": "completed", "conclusion": "failure"},
                {"name": "Still running", "status": "in_progress", "conclusion": None}] if scenario.get("failed_job") else scenario.get("ci_jobs", [
                    {"name": f"Slow unit ({mode})", "status": "completed", "conclusion": "success"}
                    for mode in ("normal", "assertions")])
        print(json.dumps([{"jobs": jobs}]))
    else:
        sys.exit("Unexpected gh command (all writes forbidden): " + repr(args))
elif name == "git":
    if args[:2] == ["fetch", "origin"]:
        if args[2:] == ["master"]:
            sys.exit(real_git("update-ref", "refs/remotes/origin/master", scenario.get("origin_master", scenario["master"])))
        if args[2:] == ["pull/123/head"]:
            (cwd / ".git/FETCH_HEAD").write_text(scenario.get("fetched_head", scenario["head"]) + "\n")
            sys.exit(0)
        sys.exit("Unexpected fetch")
    if args[:1] == ["push"]:
        trial = args[:3] == ["push", "--force", "origin"] and args[-1].endswith(":refs/heads/train/check-pr-123")
        exact_master = args[:2] == ["push", "origin"] and args[-1].endswith(":refs/heads/master")
        if args != ["push", "origin", "master"] and not trial and not exact_master:
            sys.exit("Unexpected push")
        print("Fixture push (no network)")
    else:
        if any(arg in ("clone", "pull", "ls-remote", "send-pack") for arg in args):
            sys.exit("Unshimmed remote git command refused")
        if args[:1] == ["-C"]:
            target = Path(args[1]).resolve()
            if root not in (target, *target.parents):
                sys.exit("git -C escaped the fixture")
        sys.exit(real_git(*args))
elif name in ("bun", "bunx", "cargo"):
    command = " ".join([name, *args])
    print("Fixture runner: " + command)
    if command == scenario.get("fail_runner"):
        print("Fixture runner failed", file=sys.stderr)
        sys.exit(scenario.get("runner_status", 7))
else:
    sys.exit("Unexpected shim name")
