# Memory op v1 vectors

`section8.json` is the unchanged logical example from the frozen
mc-memory-op-format-v1.md section 8, not mapper input. Its `.jcs` is UTF-8 RFC
8785 canonical JSON without a trailing newline; `.sha256` hashes those bytes.

The seven `.event.json` fixtures are host create-hook events. Their `.jcs`
files are independent literal mapping expectations, with account `111...`,
device `222...`, local id 42 and HLC (1792108800000, 0). Expected bytes were
serialized independently with Python's sorted compact JSON (these fixtures
use ASCII object keys and exact bounded integers, so this is JCS-equivalent).
`context-project.json` is the first vendored Entorhinal project result;
`authority.sha256` pins the owner plus whole-result snapshot digest. The
mapping table records writer paths, including paths that must emit nothing.
`SHA256SUMS` covers every fixture including each canonical output and digest.
