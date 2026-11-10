// Keep Pi's storage/config and harness isolation before disabling startup writers
// that could contend with unit fixtures. Real host processes never load this file.
await import(new URL("../test-preload.ts", import.meta.url).href);
const { __setScheduleStartupMaintenanceOnOpenForTests } = await import(
	"@magic-context/core/features/magic-context/storage-db"
);
__setScheduleStartupMaintenanceOnOpenForTests(false);
