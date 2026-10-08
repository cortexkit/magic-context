#!/usr/bin/env python3
"""Print Cargo.lock provenance outputs used by CI and release workflows."""

import argparse
import re
import sys
from pathlib import Path

# subc-core must come from git: CI builds the test daemon from its locked revision.
# Other CortexKit crates may also be git-pinned (unpublished commons role crates), as
# long as each one resolves to a single locked revision.
REQUIRED_GIT_CRATES = {"subc-core"}
PACKAGE_FIELDS = re.compile(r'^(name|version|source) = "([^"]*)"$', re.MULTILINE)


def package_entries(lock_text: str) -> list[dict[str, str]]:
    sections = re.split(r"(?m)^\[\[package\]\]\s*$", lock_text)[1:]
    packages = []
    for section in sections:
        fields = dict(PACKAGE_FIELDS.findall(section))
        if "name" not in fields or "version" not in fields:
            raise ValueError("Cargo.lock package entry is missing a name or version")
        packages.append(fields)
    return packages


def lock_pins(lock_text: str) -> tuple[str, str]:
    packages = package_entries(lock_text)
    pinned = []
    git_revisions: dict[str, set[str]] = {}
    for package in packages:
        name = package["name"]
        if not name.startswith(("cortexkit-", "subc-")):
            continue
        source = package.get("source", "")
        if source.startswith("git+"):
            revision = source.rsplit("#", 1)[-1]
            if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
                raise ValueError(f"{name} has an invalid locked git revision: {revision!r}")
            pinned.append(f"{name}={package['version']}@{revision}")
            git_revisions.setdefault(name, set()).add(revision)
        else:
            pinned.append(f"{name}={package['version']}")

    missing = REQUIRED_GIT_CRATES - set(git_revisions)
    if missing:
        raise ValueError(f"expected a locked git revision for {sorted(missing)}, got {git_revisions}")
    split = {name: revisions for name, revisions in git_revisions.items() if len(revisions) != 1}
    if split:
        raise ValueError(f"expected one locked git revision per crate, got {split}")
    subc_revision = next(iter(git_revisions["subc-core"]))
    return subc_revision, ",".join(sorted(pinned))


def run_self_test() -> int:
    subc_revision = "1a14993c120725fa1dce7267b6e7d0823835930c"
    commons_revision = "067701f1ab61cd2c81aa58fb66b0cb65fbaef9e7"
    role_revision = "9abd24916a087162b7650ad7db71cf287be1330c"
    fixture = f'''[[package]]
name = "subc-core"
version = "0.20.55"
source = "git+https://github.com/cortexkit/subconscious?rev={subc_revision}#{subc_revision}"

[[package]]
name = "cortexkit-cache-core"
version = "0.1.0"
source = "git+https://github.com/cortexkit/commons?rev={commons_revision}#{commons_revision}"

[[package]]
name = "cortexkit-role-step-transform-provider"
version = "0.1.1"
source = "git+https://github.com/cortexkit/commons?rev={role_revision}#{role_revision}"

[[package]]
name = "subc-protocol"
version = "0.29.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
'''
    try:
        actual = lock_pins(fixture)
        expected_crates = ",".join(
            sorted(
                [
                    f"cortexkit-cache-core=0.1.0@{commons_revision}",
                    f"cortexkit-role-step-transform-provider=0.1.1@{role_revision}",
                    f"subc-core=0.20.55@{subc_revision}",
                    "subc-protocol=0.29.1",
                ]
            )
        )
        if actual != (subc_revision, expected_crates):
            raise AssertionError(f"unexpected pins: {actual!r}")
        try:
            lock_pins(fixture.replace(f"?rev={subc_revision}#{subc_revision}", "?rev=invalid#invalid"))
        except ValueError:
            pass
        else:
            raise AssertionError("invalid subc-core git revision was accepted")
        try:
            lock_pins(fixture.replace('name = "subc-core"', 'name = "subc-core-renamed"'))
        except ValueError:
            pass
        else:
            raise AssertionError("a lockfile without a git-pinned subc-core was accepted")
        try:
            lock_pins(
                fixture
                + f'''
[[package]]
name = "cortexkit-cache-core"
version = "0.1.1"
source = "git+https://github.com/cortexkit/commons?rev={role_revision}#{role_revision}"
'''
            )
        except ValueError:
            pass
        else:
            raise AssertionError("a crate locked at two git revisions was accepted")
    except (KeyError, ValueError, AssertionError) as error:
        print(f"FAIL test_locked_crate_outputs: {error}", file=sys.stderr)
        return 1
    print("PASS test_locked_crate_outputs")
    print("PASS test_invalid_git_revision_refused")
    print("PASS test_missing_subc_core_refused")
    print("PASS test_split_git_revision_refused")
    print("All 4 Cargo.lock pin self-tests passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="exercise lockfile parsing and pin validation")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()
    try:
        revision, crates = lock_pins(Path("Cargo.lock").read_text(encoding="utf-8"))
    except (OSError, KeyError, ValueError) as error:
        print(f"ERROR: cannot read Cargo.lock provenance: {error}", file=sys.stderr)
        return 1
    print(f"subc_revision={revision}")
    print(f"locked_crates={crates}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
