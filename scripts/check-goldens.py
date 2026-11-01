#!/usr/bin/env python3
"""Run every checked-in golden generator that implements the read-only --check contract."""
import os
import hashlib
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
check_flag = re.compile(r'''(?:process|Bun)\.argv\.includes\(["']--check["']\)''')
generators = sorted(
    path for path in (root / "crates").rglob("*.ts")
    if not path.name.endswith(".test.ts") and check_flag.search(path.read_text())
)
env = dict(os.environ)
# Catalog vectors are optional in the generator. Restrict their lookup to this checkout's .siblings directory.
env.setdefault("MC_CATALOG_COMMONS_REPO", str(root / ".siblings/commons"))
env.setdefault("MC_CATALOG_PREFRONTAL_REPO", str(root / ".siblings/prefrontal"))
failed = 0
for path in generators:
    name = str(path.relative_to(root))
    args = ["bun", name, "--check"]
    if path.name == "gen-ingress-golden.ts":
        # The producer lives in another repository. Check its vendored bytes against
        # the same independent cross-repository pin used by the Rust consumer first.
        source = (root / "crates/mc-module/src/transform.rs").read_text()
        pin = re.search(r'fn ck_wire_golden_bytes_match_cross_repo_pin\(\).*?const GOLDEN_SHA256: &str\s*=\s*"([a-f0-9]{64})"', source, re.S)
        fixture = root / "crates/mc-module/testdata/ck_wire_golden.json"
        if not pin or hashlib.sha256(fixture.read_bytes()).hexdigest() != pin.group(1):
            failed += 1
            print("FAIL CK wire cross-repository source pin", flush=True)
            continue
        print("PASS CK wire cross-repository source pin", flush=True)
        args += ["--source", str(fixture)]
    result = subprocess.run(args, cwd=root, env=env, check=False)
    failed += result.returncode != 0
    print(f"{'PASS' if result.returncode == 0 else 'FAIL'} golden {name}", flush=True)
if not generators:
    raise SystemExit("FAIL: no --check golden generators found")
print(f"Golden generators: {len(generators) - failed}/{len(generators)} passed")
sys.exit(bool(failed))
