// Keep the shared storage/config isolation used by end-to-end tests, then apply
// the unit-only policy before any fixture can open managed storage.
// An inherited OpenCode DB path takes precedence over the fixtures' XDG roots.
delete process.env.OPENCODE_DB;
await import(new URL("../test-preload.ts", import.meta.url).href);
const { __setScheduleStartupMaintenanceOnOpenForTests } = await import(
    "./features/magic-context/storage-db"
);
// Plugin logs and historian response dumps go under os.tmpdir(). Move it to a
// throwaway root so no unit test (CLI tests included, which share this preload)
// writes or reads them in the machine's temp directory.
const { afterAll } = await import("bun:test");
const { redirectTempDirForTests } = await import("./shared/test-temp-dir");
redirectTempDirForTests(afterAll);
__setScheduleStartupMaintenanceOnOpenForTests(false);
