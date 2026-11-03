#!/usr/bin/env python3
"""Print Cargo.lock provenance outputs used by CI and release workflows."""

import argparse
import re
import sys
from pathlib import Path
from typing import Optional

# The daemon is an integration-test tool, not a dependency of the registry SDK.
# Its full revision remains pinned in the workspace even when Cargo omits the
# unused subc-core dependency from the runtime lockfile.
DAEMON_REPOSITORY = "https://github.com/cortexkit/subconscious"
PACKAGE_FIELDS = re.compile(r'^(name|version|source) = "([^"]*)"$', re.MULTILINE)


def package_entries(lock_text: str) -> list[dict[str, str]]:
    sections = re.findall(r"(?ms)^\[\[package\]\][ \t]*\r?\n(.*?)(?=^\[\[|\Z)", lock_text)
    packages = []
    for section in sections:
        fields = dict(PACKAGE_FIELDS.findall(section))
        if "name" not in fields or "version" not in fields:
            raise ValueError("Cargo.lock package entry is missing a name or version")
        packages.append(fields)
    return packages


def workspace_pins(manifest_text: str) -> dict:
    """Read only the exact pin forms we support; unfamiliar TOML fails closed.

    Keep this standalone check usable with Python 3.9, without a TOML package or
    a dependency on Bun/Cargo just to identify the integration daemon revision.
    """
    tables = list(re.finditer(r"(?m)^\[workspace\.dependencies\][ \t]*(?:#[^\n]*)?$", manifest_text))
    if len(tables) != 1:
        raise ValueError("expected one workspace dependency table")
    block = re.split(r"(?m)^\[", manifest_text[tables[0].end():], maxsplit=1)[0]

    def entry(name: str, pattern: str) -> str:
        matches = re.findall(rf'(?m)^{re.escape(name)}\s*=\s*({pattern})[ \t]*(?:#[^\n]*)?$', block)
        if len(matches) != 1:
            raise ValueError(f"expected one supported workspace pin for {name}")
        return matches[0]

    daemon = entry("subc-core", r'\{[^\n}]*\}')
    fields = re.findall(r'(git|rev)\s*=\s*"([^"\\]*)"', daemon)
    if len(fields) != 2 or {key for key, _ in fields} != {"git", "rev"}:
        raise ValueError("expected git and rev in workspace subc-core pin")
    remainder = re.sub(r'(git|rev)\s*=\s*"[^"\\]*"', "", daemon[1:-1])
    if re.sub(r"[\s,]", "", remainder):
        raise ValueError("unsupported workspace subc-core pin syntax")
    return {
        "subc-core": dict(fields),
        **{name: entry(name, r'"[^"\\]*"')[1:-1] for name in ("subc-client-rs", "subc-protocol")},
    }


def lock_pins(lock_text: str, manifest_text: Optional[str] = None) -> tuple[str, str]:
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

    split = {name: revisions for name, revisions in git_revisions.items() if len(revisions) != 1}
    if split:
        raise ValueError(f"expected one locked git revision per crate, got {split}")
    locked_daemon = git_revisions.get("subc-core", set())
    if manifest_text is None:
        if not locked_daemon:
            raise ValueError("expected a locked subc-core revision or a workspace daemon pin")
        subc_revision = next(iter(locked_daemon))
    else:
        dependencies = workspace_pins(manifest_text)
        daemon = dependencies["subc-core"]
        subc_revision = daemon.get("rev", "")
        if daemon.get("git") != DAEMON_REPOSITORY or not re.fullmatch(r"[0-9a-f]{40}", subc_revision):
            raise ValueError("workspace subc-core must pin the daemon repository at a full git revision")
        if locked_daemon and locked_daemon != {subc_revision}:
            raise ValueError("Cargo.lock subc-core and the workspace daemon pin disagree")
        if not locked_daemon:
            if any(package["name"] == "subc-core" for package in packages):
                raise ValueError("subc-core must not resolve from a registry")
            for name in ("subc-client-rs", "subc-protocol"):
                spec = dependencies[name]
                locked = [package for package in packages if package["name"] == name]
                if not isinstance(spec, str) or not spec.startswith("=") or len(locked) != 1:
                    raise ValueError(f"expected one exactly pinned registry SDK package for {name}")
                if locked[0]["version"] != spec[1:] or locked[0].get("source") != "registry+https://github.com/rust-lang/crates.io-index":
                    raise ValueError(f"{name} does not match its workspace registry pin")
            pinned.append(f"subc-core=integration@{subc_revision}")
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
    manifest = f'''[workspace.dependencies]
subc-core = {{ git = "{DAEMON_REPOSITORY}", rev = "{subc_revision}" }}
subc-client-rs = "=0.33.0"
subc-protocol = "=0.29.1"
'''
    registry = fixture[fixture.index('[[package]]\nname = "cortexkit-cache-core"'):]
    registry += '''\n[[package]]
name = "subc-client-rs"
version = "0.33.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
'''
    registry_test = "test_registry_sdk_and_workspace_daemon_pin"
    try:
        revision, crates = lock_pins(registry, manifest)
        assert revision == subc_revision
        assert f"subc-core=integration@{subc_revision}" in crates
        print("PASS test_registry_sdk_and_workspace_daemon_pin")
        registry_test = "test_unused_patches_are_not_runtime_packages"
        unused = registry + '''\n[[patch.unused]]
name = "subc-core"
version = "0.1.0"
source = "git+https://example.com/unused#invalid"
'''
        assert lock_pins(unused, manifest) == (revision, crates)
        print("PASS test_unused_patches_are_not_runtime_packages")
        registry_test = "test_invalid_registry_sdk_or_daemon_pin_refused"
        invalid = [
            (registry, manifest.replace(subc_revision, "main")),
            (registry, manifest.replace(DAEMON_REPOSITORY, "https://example.com/other")),
            (fixture, manifest.replace(subc_revision, "0" * 40)),
            (registry.replace('version = "0.33.0"', 'version = "0.33.1"'), manifest),
            (registry.replace('name = "subc-client-rs"', 'name = "unrelated"'), manifest),
        ]
        for lock, workspace in invalid:
            try:
                lock_pins(lock, workspace)
            except (KeyError, ValueError):
                continue
            raise AssertionError("invalid SDK/daemon provenance was accepted")
        print("PASS test_invalid_registry_sdk_or_daemon_pin_refused (5 cases)")
    except (KeyError, ValueError, AssertionError) as error:
        print(f"FAIL {registry_test}: {error}", file=sys.stderr)
        return 1
    print("All 11 Cargo provenance self-test cases passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="exercise lockfile parsing and pin validation")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()
    try:
        revision, crates = lock_pins(
            Path("Cargo.lock").read_text(encoding="utf-8"),
            Path("Cargo.toml").read_text(encoding="utf-8"),
        )
    except (OSError, KeyError, ValueError) as error:
        print(f"ERROR: cannot read Cargo.lock provenance: {error}", file=sys.stderr)
        return 1
    print(f"subc_revision={revision}")
    print(f"locked_crates={crates}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
