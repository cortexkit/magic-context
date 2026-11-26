# Cache-bust sentinel log fixture

`cache-bust-runner-structured.log.txt` is a byte-for-byte copy of
`packages/plugin/scripts/fixtures/cache-bust-runner-structured.log.txt`, from
`48e36b2bbd` on this repository's `master` branch, where the sentinel reader
is `packages/plugin/scripts/cache-bust-runner-log.ts`. The Rust tests check
the fixture against actual module logs and check that the copies agree.
