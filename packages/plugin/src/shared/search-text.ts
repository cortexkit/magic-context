import { removeNestedBlocks } from "./system-directive";

export function removeTaskNotifications(text: string): string {
    return removeNestedBlocks(text, ["task", "task_cohort"]);
}

/** Remove injected notifications before scoring or rendering; previously saved hints replay unchanged. */
export function cleanSearchText(text: string): string {
    return removeNestedBlocks(text, ["system-reminder", "task", "task_cohort"])
        .replace(/\s+/g, " ")
        .trim();
}

const QUERY_STOP_WORDS = new Set(
    "a an and are as at be been by can could did do does for from how i in is it me my of on or our please should that the their them there these they this to us was we were what when where which who why will with would you your".split(
        " ",
    ),
);

function terms(text: string): string[] {
    return [
        ...new Set(
            (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
                (term) => !QUERY_STOP_WORDS.has(term),
            ),
        ),
    ];
}

/** Score the share of distinct query terms present, independently of other results. */
export function keywordRelevance(query: string, content: string): number {
    const needles = terms(query);
    if (needles.length === 0) return 0;
    const words = new Set(terms(cleanSearchText(content)));
    return (0.8 * needles.filter((term) => words.has(term)).length) / needles.length;
}

const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const CJK_RUN_SPLIT = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u;

function hintTerms(text: string): string[] {
    return [
        ...new Set(
            terms(text)
                .flatMap((term) => term.split(CJK_RUN_SPLIT))
                .filter((term) => term.length > 0 && !QUERY_STOP_WORDS.has(term)),
        ),
    ];
}

function characterBigrams(run: string): string[] {
    const characters = [...run];
    return characters.length === 1
        ? characters
        : characters.slice(1).map((character, index) => characters[index] + character);
}

/** Match unspaced clauses for hints without changing retrieval or snippet scoring. */
export function hintKeywordRelevance(query: string, content: string): number {
    const needles = hintTerms(query);
    if (needles.length === 0) return 0;
    const words = new Set(hintTerms(cleanSearchText(content)));
    const runs = [...words].filter((word) => CJK_RUN.test(word));
    const bigrams = new Set(runs.flatMap(characterBigrams));
    let matched = 0;
    for (const needle of needles) {
        if (!CJK_RUN.test(needle)) {
            matched += Number(words.has(needle));
            continue;
        }
        const grams = characterBigrams(needle);
        if ([...needle].length === 1) {
            matched += Number(runs.some((run) => run.includes(needle)));
            continue;
        }
        // Count each clause as one term so filler bigrams across word boundaries
        // do not dilute it; require half coverage so shared function words alone do not pass.
        matched += Math.min(
            1,
            grams.filter((gram) => bigrams.has(gram)).length / Math.ceil(grams.length / 2),
        );
    }
    return (0.8 * matched) / needles.length;
}

/** Pick the densest matching passage before compression can discard the matched words. */
export function matchedSearchSnippet(content: string, query: string, cap = 220): string {
    const text = cleanSearchText(content);
    const needles = new Set(terms(query));
    const matches = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].filter((match) =>
        needles.has(match[0].toLowerCase()),
    );
    if (matches.length === 0) return "";
    let bestStart = matches[0].index;
    let bestCoverage = -1;
    for (const match of matches) {
        const start = Math.max(0, match.index - Math.floor(cap / 5));
        const coverage = keywordRelevance(query, text.slice(start, start + cap));
        if (coverage > bestCoverage) {
            bestStart = start;
            bestCoverage = coverage;
        }
    }
    // Avoid emitting half a word at the left edge of a passage.
    if (bestStart > 0) {
        const boundary = text.indexOf(" ", bestStart);
        if (boundary >= 0 && boundary < matches[matches.length - 1].index) bestStart = boundary + 1;
    }
    const passage = text.slice(bestStart, bestStart + cap).trim();
    return `${bestStart > 0 ? "…" : ""}${passage}${bestStart + cap < text.length ? "…" : ""}`;
}
