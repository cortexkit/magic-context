#!/usr/bin/env python3
"""Exercise discovery, independent failures, and the cross-repository byte pin without running generators."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class GoldenChecks(unittest.TestCase):
    def setUp(self):
        (ROOT / "target/scratch").mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "target/scratch")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/check-goldens.py", self.root / "scripts/check-goldens.py")
        self.gen = self.root / "crates/mc-module/gen"
        self.gen.mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        bun = self.bin / "bun"
        bun.write_text('#!/bin/sh\nprintf "%s\\n" "$*"\ncase "$*" in *broken*) exit 4;; esac\n')
        bun.chmod(0o755)

    def run_checks(self):
        return subprocess.run(
            ["python3", str(self.root / "scripts/check-goldens.py")],
            env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}"},
            text=True, capture_output=True, check=False,
        )

    def generator(self, name):
        (self.gen / name).write_text('const check = process.argv.includes("--check");\n')

    def test_no_generators_fails_closed(self):
        result = self.run_checks()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no --check golden generators found", result.stderr)

    def test_generator_failure_does_not_hide_later_checks(self):
        self.generator("a-broken.ts")
        self.generator("z-current.ts")
        result = self.run_checks()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PASS golden crates/mc-module/gen/z-current.ts", result.stdout)
        self.assertIn("1/2 passed", result.stdout)

    def prepare_ingress(self, pin=True):
        self.generator("gen-ingress-golden.ts")
        fixture = self.root / "crates/mc-module/testdata/ck_wire_golden.json"
        fixture.parent.mkdir()
        fixture.write_bytes(b"wire fixture")
        source = self.root / "crates/mc-module/src/transform.rs"
        source.parent.mkdir()
        digest = hashlib.sha256(b"wire fixture").hexdigest()
        source.write_text(f'fn ck_wire_golden_bytes_match_cross_repo_pin() {{ const GOLDEN_SHA256: &str = "{digest}"; }}' if pin else "")
        return fixture

    def test_ingress_uses_vendored_source_only_after_independent_pin_matches(self):
        fixture = self.prepare_ingress()
        result = self.run_checks()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"--check --source {fixture}", result.stdout)
        self.assertIn("PASS CK wire cross-repository source pin", result.stdout)
        fixture.write_bytes(b"different producer bytes")
        result = self.run_checks()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL CK wire cross-repository source pin", result.stdout)
        self.assertNotIn("--source", result.stdout)

    def test_missing_rust_pin_is_not_a_pass(self):
        self.prepare_ingress(pin=False)
        self.assertNotEqual(self.run_checks().returncode, 0)


if __name__ == "__main__":
    unittest.main()
