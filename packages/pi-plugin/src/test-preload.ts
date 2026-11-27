// Keep Pi's storage/config and harness isolation before disabling startup writers
// that could contend with unit fixtures. Real host processes never load this file.
// An inherited OpenCode DB path takes precedence over the fixtures' XDG roots.
delete process.env.OPENCODE_DB;
await import(new URL("../test-preload.ts", import.meta.url).href);
const { __setScheduleStartupMaintenanceOnOpenForTests } = await import(
	"@magic-context/core/features/magic-context/storage-db"
);
// Plugin logs and historian response dumps go under os.tmpdir(). Move it to a
// throwaway root so no unit test writes them into the machine's temp directory.
const { afterAll } = await import("bun:test");
const { redirectTempDirForTests } = await import(
	"@magic-context/core/shared/test-temp-dir"
);
redirectTempDirForTests(afterAll);
__setScheduleStartupMaintenanceOnOpenForTests(false);
