#!/usr/bin/env python3
"""Exercise the installer with a local curl stub and no network."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


INSTALL_OPENCODE = Path(__file__).with_name("install-opencode.sh").resolve()
REDIRECT = "https://github.com/anomalyco/opencode/releases/latest"
API = "https://api.github.com/repos/anomalyco/opencode/releases/latest"

CURL_STUB = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
urls = [arg for arg in args if arg.startswith("https://")]
assert len(urls) == 1, args
url = urls[0]
log = Path(os.environ["CURL_LOG"])
calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
with log.open("a") as out:
    print(json.dumps({"url": url, "args": args}), file=out)

if url == "https://opencode.ai/install":
    Path(args[args.index("-o") + 1]).write_text("""set -eu
[[ $# == 2 && $1 == --version ]]
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\\necho %s\\n' "$2" > "$HOME/.opencode/bin/opencode"
chmod +x "$HOME/.opencode/bin/opencode"
""")
elif url == "https://github.com/anomalyco/opencode/releases/latest":
    if sum(call["url"] == url for call in calls) < int(os.environ["REDIRECT_FAILURES"]):
        print("curl: (22) HTTP 504", file=sys.stderr)
        sys.exit(22)
    print("https://github.com/anomalyco/opencode/releases/tag/v1.20.3-rc.1")
elif url == "https://api.github.com/repos/anomalyco/opencode/releases/latest":
    if os.environ["API_FAILS"] == "1":
        print("curl: (22) HTTP 503", file=sys.stderr)
        sys.exit(22)
    print(json.dumps({"name": "Not the version", "tag_name": "v1.20.4"}))
else:
    sys.exit(f"Unexpected curl URL: {url}")
'''


class InstallOpenCodeTests(unittest.TestCase):
    def run_install(self, *, redirect_failures=999, api_fails=False, version="latest", **tokens):
        with tempfile.TemporaryDirectory() as temp:
            test_dir = Path(temp)
            curl = test_dir / "curl"
            curl.write_text(CURL_STUB)
            curl.chmod(0o755)
            log = test_dir / "curl.log"
            env = {key: value for key, value in os.environ.items() if key not in {"GH_TOKEN", "GITHUB_TOKEN"}}
            env.update(PATH=f"{test_dir}{os.pathsep}{os.environ['PATH']}", HOME=temp, CURL_LOG=str(log),
                       OPENCODE_VERSION=version, OPENCODE_LATEST_RETRY_STEP_SECONDS="0",
                       REDIRECT_FAILURES=str(redirect_failures), API_FAILS=str(int(api_fails)), **tokens)
            result = subprocess.run(["bash", str(INSTALL_OPENCODE)], env=env, capture_output=True, text=True, timeout=10)
            return result, [json.loads(line) for line in log.read_text().splitlines()]

    def test_latest_redirect_recovers_after_the_old_retry_budget(self):
        result, calls = self.run_install(redirect_failures=6)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("resolved latest version via GitHub release redirect", result.stdout)
        self.assertEqual(result.stdout.splitlines()[-1], "1.20.3-rc.1")
        self.assertEqual([call["url"] for call in calls], ["https://opencode.ai/install"] + [REDIRECT] * 7)

    def test_exhausted_redirect_falls_back_to_api_with_optional_auth(self):
        for tokens, expected in [({"GH_TOKEN": "gh", "GITHUB_TOKEN": "github"}, ["Authorization: Bearer gh"]),
                                 ({"GITHUB_TOKEN": "github"}, ["Authorization: Bearer github"]), ({}, [])]:
            with self.subTest(token_sources=sorted(tokens)):
                result, calls = self.run_install(**tokens)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("resolved latest version via GitHub releases API", result.stdout)
                self.assertEqual(result.stdout.splitlines()[-1], "1.20.4")
                self.assertEqual([call["url"] for call in calls], ["https://opencode.ai/install"] + [REDIRECT] * 11 + [API])
                self.assertFalse(any(arg.startswith("Authorization:") for call in calls[:-1] for arg in call["args"]))
                self.assertEqual([arg for arg in calls[-1]["args"] if arg.startswith("Authorization:")], expected)

    def test_both_latest_paths_fail_with_a_clear_error(self):
        result, calls = self.run_install(api_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not resolve latest OpenCode release via GitHub release redirect or releases API", result.stderr)
        self.assertNotIn("installing opencode", result.stdout)
        self.assertEqual(calls[-1]["url"], API)

    def test_pinned_version_does_not_use_either_lookup(self):
        result, calls = self.run_install(version="1.18.32")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[-1], "1.18.32")
        self.assertEqual([call["url"] for call in calls], ["https://opencode.ai/install"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
