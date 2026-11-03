import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runnerReminderFixture } from "../../test-fixtures/runtime/gen-runner-reminder-fixture";

test("runner reminder fixture has no drift from TypeScript reminder bytes", () => {
    const committed = JSON.parse(
        readFileSync(
            new URL("../../test-fixtures/runtime/runner-reminder-fixture.json", import.meta.url),
            "utf8",
        ),
    );
    expect(committed).toEqual(runnerReminderFixture());
});
