#!/usr/bin/env bash
# Build on a machine with the target OS/architecture first:
# cargo test --no-run -p mc-module --test wire
# Cargo prints the wire test executable's path. Bring it and all three module
# binaries to the isolated VM; this script never invokes a build tool.
set -euo pipefail

if [ "$#" -ne 7 ]; then
	echo "usage: $0 WIRE_TEST_BIN CK_MC_BIN DATA_HOME PROJECT_ROOT PROJECT_ID CK_SUBC_BIN MOCK_RUNNER_BIN" >&2
	exit 2
fi

wire_test=$1
export MC_REHEARSAL_CK_MC_BIN=$2
export MC_REHEARSAL_DATA_HOME=$3
export MC_REHEARSAL_PROJECT_ROOT=$4
export MC_REHEARSAL_PROJECT_ID=$5
export MC_TEST_CK_SUBC_BIN=$6
export MC_TEST_MOCK_RUNNER_BIN=$7

for binary in "$wire_test" "$MC_REHEARSAL_CK_MC_BIN" "$MC_TEST_CK_SUBC_BIN" "$MC_TEST_MOCK_RUNNER_BIN"; do
	if [ ! -x "$binary" ]; then
		echo "not an executable: $binary" >&2
		exit 2
	fi
done

# The test validates the data home against the original HOME before launching
# anything. It writes to the supplied copy in place, including a session note
# through the ctx_note tool.
exec "$wire_test" --exact rehearsal_a_head_on_a_real_store --ignored --nocapture
