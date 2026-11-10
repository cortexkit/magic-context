// Keep the shared storage/config isolation used by end-to-end tests, then apply
// the unit-only policy before any fixture can open managed storage.
await import(new URL("../test-preload.ts", import.meta.url).href);
const { __setScheduleStartupMaintenanceOnOpenForTests } = await import(
    "./features/magic-context/storage-db"
);
__setScheduleStartupMaintenanceOnOpenForTests(false);
