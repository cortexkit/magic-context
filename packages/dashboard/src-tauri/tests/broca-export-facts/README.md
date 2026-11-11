# Broca export reader fixture

Synthetic data supplied by Broca's real export writer at source snapshot
`4bda042862fc903c41ffdd91e1e521b730e4312d`, from the shared reader kit
`shared-broca-readers/export-facts-1111`. No live store or real session data was
used. `fixture-rows.md` documents the eight rows and their generation.

The original `SHA256SUMS` is copied unchanged for provenance; it also names
contract documents and the SQL dump that remain in the upstream kit. The
checksums for the database and row guide match those original entries.
Tests copy the database to a temporary directory before appending edge cases.
