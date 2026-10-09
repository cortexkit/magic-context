import { expect, it } from "bun:test";
import { removeDeprecatedReasoningAge } from "./reasoning-config-migration";

it("doctor removes deprecated age without converting it, and explains a low-age override", () => {
    const config = { clear_reasoning_age: 10, keep_reasoning_tokens: 3000 };
    expect(removeDeprecatedReasoningAge(config)).toHaveLength(2);
    expect(config).toEqual({ keep_reasoning_tokens: 3000 });
    expect(removeDeprecatedReasoningAge({ clear_reasoning_age: 50 })).toHaveLength(1);
    expect(removeDeprecatedReasoningAge({})).toEqual([]);
});
