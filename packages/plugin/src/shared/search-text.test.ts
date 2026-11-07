import { expect, test } from "bun:test";
import {
    cleanSearchText,
    hintKeywordRelevance,
    keywordRelevance,
    matchedSearchSnippet,
} from "./search-text";
import { removeSystemReminders } from "./system-directive";

test("hint scoring preserves exact English and other space-separated keyword scores", () => {
    const cases: Array<[string, string, number]> = [
        ["explain historian cache wiring", "cache icons", 0.2],
        ["historian cache wiring", "historian cache wiring details", 0.8000000000000002],
        ["please explain cache wiring to me", "cache wiring", 0.5333333333333333],
        ["CACHE cache cache_timeout", "cache_timeout", 0.4],
        ["how are you", "how are you", 0],
        ["historian cache", "<task>historian cache</task>", 0],
        ["résumé über prüfen", "über prüfen", 0.5333333333333333],
        ["память кеш", "кеш", 0.4],
        ["ذاكرة تخزين", "تخزين", 0.4],
    ];
    for (const [query, content, expected] of cases) {
        expect(keywordRelevance(query, content)).toBe(expected);
        expect(hintKeywordRelevance(query, content)).toBe(expected);
    }
});

test("only hint scoring splits unspaced CJK runs into overlapping character bigrams", () => {
    expect(keywordRelevance("MC_Maze 残差怎样汇总？", "MC_Maze 残差按种子汇总。")).toBe(0.4);
    expect(hintKeywordRelevance("残差", "残留")).toBe(0);
    expect(hintKeywordRelevance("差", "残差")).toBe(0.8);
    expect(hintKeywordRelevance("𠮷野家", "𠮷野川")).toBe(0.8);
    expect(hintKeywordRelevance("かながき", "かながきです")).toBe(0.8);
    expect(hintKeywordRelevance("カタカナ", "カタカナです")).toBe(0.8);
    expect(hintKeywordRelevance("프로젝트캐시", "프로젝트의캐시")).toBe(0.8);
    expect(hintKeywordRelevance("cache残差", "cache残差按种子汇总")).toBe(0.8);
    expect(hintKeywordRelevance("差", "<task>残差</task> unrelated")).toBe(0);
});

test("nested reminder contents stay quarantined through the outer closing tag", () => {
    expect(
        removeSystemReminders(
            'before <SYSTEM-REMINDER origin="host">outer <system-reminder>inner</system-reminder> leaked tail</SYSTEM-REMINDER> after',
        ),
    ).toBe("before  after");
    expect(removeSystemReminders("before <system-reminder>unfinished")).toBe("before");
    expect(removeSystemReminders("before </system-reminder> after")).toBe("before  after");
});

test("mismatched notification closes cannot release hidden content", () => {
    expect(cleanSearchText("kept <task>hidden </task_cohort> still hidden</task> kept")).toBe(
        "kept kept",
    );
    expect(cleanSearchText("kept <task id='finished'/> kept")).toBe("kept kept");
});

test("task notification trees and cut legacy XML never become hint text", () => {
    expect(
        cleanSearchText(
            '<task_cohort id="parent"><task id="child">background result</task>status</task_cohort> actual answer',
        ),
    ).toBe("actual answer");
    expect(cleanSearchText('<task id="truncated">background result…')).toBe("");
});

test("keyword confidence measures absolute distinct term coverage, not result rank", () => {
    expect(keywordRelevance("explain historian cache wiring", "cache icons")).toBeCloseTo(0.2);
    expect(
        keywordRelevance("historian cache wiring", "historian cache wiring details"),
    ).toBeCloseTo(0.8);
    expect(keywordRelevance("historian cache wiring", "<task>historian cache wiring</task>")).toBe(
        0,
    );
});

test("matched snippets prefer a dense passage over an irrelevant first line", () => {
    const content = `Header cache. ${"padding ".repeat(150)}Historian cache wiring uses incremental pools. ${"trailing ".repeat(100)}`;
    const snippet = matchedSearchSnippet(content, "historian cache wiring", 80);
    expect(snippet).toContain("Historian cache wiring");
    expect(snippet).not.toContain("Header");
    expect(matchedSearchSnippet(content, "unrelated deployment")).toBe("");
});
