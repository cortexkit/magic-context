import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { insertTag } from "../../features/magic-context/storage-tags";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { renderItemByTag, renderMessageByOrdinal, renderVerboseRange } from "./render";

const sessionId = "attachment-recovery";
const fixtures = [
    {
        name: "file",
        part: {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            url: "file:///work/report.pdf",
        },
        notice: "[file] report.pdf (application/pdf) — stored location: file:///work/report.pdf; content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "image",
        part: { type: "image", mimeType: "image/png", data: "secret-inline-bytes" },
        notice: "[file] (image/png); content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "OpenCode inline screenshot",
        part: {
            type: "file",
            filename: "screenshot.png",
            mime: "image/png",
            url: "data:image/png;base64,secret-inline-bytes",
        },
        notice: "[file] screenshot.png (image/png); content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "stored image URL",
        part: { type: "image", mimeType: "image/jpeg", url: "https://example.com/image.jpg" },
        notice: "[file] (image/jpeg) — stored location: https://example.com/image.jpg; content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "path without media type",
        part: { type: "file", path: "/work/artifact", filename: "artifact" },
        notice: "[file] artifact — stored location: /work/artifact; content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "source URI behind inline bytes",
        part: {
            type: "file",
            name: "capture.png",
            mediaType: "image/png",
            url: "data:image/png;base64,secret-inline-bytes",
            source: { uri: "file:///work/capture.png" },
        },
        notice: "[file] capture.png (image/png) — stored location: file:///work/capture.png; content not recovered. If needed, ask the user to attach it again.",
    },
    {
        name: "OpenCode source path behind inline bytes",
        part: {
            type: "file",
            filename: "capture.png",
            mime: "image/png",
            url: "data:image/png;base64,secret-inline-bytes",
            source: { type: "file", path: "/work/capture.png" },
        },
        notice: "[file] capture.png (image/png) — stored location: /work/capture.png; content not recovered. If needed, ask the user to attach it again.",
    },
];

for (const fixture of fixtures) {
    for (const mode of ["tag", "message", "range"] as const) {
        test(`${mode}: ${fixture.name} says content was not recovered`, () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            const cleanup = setRawMessageProvider(sessionId, {
                readMessages: () => [
                    {
                        ordinal: 1,
                        id: "message",
                        role: "user",
                        parts: [{ type: "text", text: "Inspect it." }, fixture.part],
                    },
                ],
            });
            try {
                insertTag(db, sessionId, "message:file1", "file", 10, 1);
                const output =
                    mode === "tag"
                        ? renderItemByTag(db, sessionId, 1)
                        : mode === "message"
                          ? renderMessageByOrdinal(sessionId, 1)
                          : renderVerboseRange(sessionId, 1, 1, 15_000).text;
                expect(output).toContain(fixture.notice);
                expect(output).not.toContain("secret-inline-bytes");
                expect(output).not.toContain("data:");
                expect(output.split("\n").some((line) => line.endsWith(fixture.notice))).toBe(true);
            } finally {
                cleanup();
                db.close();
            }
        });
    }
}

test("text recovery and range previews are byte-identical", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const cleanup = setRawMessageProvider(sessionId, {
        readMessages: () => [
            {
                ordinal: 1,
                id: "text",
                role: "user",
                parts: [{ type: "text", text: " exact\ntext " }],
            },
        ],
    });
    try {
        insertTag(db, sessionId, "text:p0", "message", 10, 1);
        expect(renderItemByTag(db, sessionId, 1)).toBe("  [text]\n exact\ntext ");
        expect(renderMessageByOrdinal(sessionId, 1)).toBe(
            "[1] U (user) — full recovery:\n\n  [text]\n exact\ntext ",
        );
        expect(renderVerboseRange(sessionId, 1, 1, 15_000).text).toBe(
            "[1] U (user)\n    • exact\ntext",
        );
    } finally {
        cleanup();
        db.close();
    }
});
