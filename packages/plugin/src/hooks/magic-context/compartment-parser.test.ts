import { describe, expect, it } from "bun:test";
import { parseCompartmentOutput } from "./compartment-parser";

describe("parseCompartmentOutput", () => {
    it("parses USER_PREFERENCES fact blocks", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="1" end="2" title="Prompt cleanup">Updated the summarizer prompt.</compartment>
</compartments>
<facts>
<USER_PREFERENCES>
* Always do feat -> integrate -> build after fixes unless explicitly told not to.
</USER_PREFERENCES>
</facts>
<meta>
<messages_processed>1-2</messages_processed>
</meta>
</output>`);

        expect(parsed.facts).toEqual([
            {
                category: "USER_PREFERENCES",
                content:
                    "Always do feat -> integrate -> build after fixes unless explicitly told not to.",
            },
        ]);
    });

    it("parses USER_DIRECTIVES facts", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="3" end="4" title="Decision capture">Preserved the user's durable goal.</compartment>
</compartments>
<facts>
<USER_DIRECTIVES>
* Keep the magic-context rename broad and user-facing.
</USER_DIRECTIVES>
</facts>
<meta>
<messages_processed>3-4</messages_processed>
</meta>
</output>`);

        expect(parsed.facts).toContainEqual({
            category: "USER_DIRECTIVES",
            content: "Keep the magic-context rename broad and user-facing.",
        });
    });

    it("unescapes escaped XML content in titles, compartments, and facts", () => {
        const parsed = parseCompartmentOutput(`
<output>
<compartments>
<compartment start="5" end="6" title="Team&apos;s &quot;rules&quot;">Keep &lt;instruction&gt; blocks &amp; notes safe.</compartment>
</compartments>
<facts>
<USER_DIRECTIVES>
* Preserve Sam&apos;s decision &amp; keep &lt;magic-context&gt; wording.
</USER_DIRECTIVES>
</facts>
<meta>
<messages_processed>5-6</messages_processed>
</meta>
</output>`);

        expect(parsed.compartments).toEqual([
            {
                startMessage: 5,
                endMessage: 6,
                title: `Team's "rules"`,
                content: "Keep <instruction> blocks & notes safe.",
            },
        ]);
        expect(parsed.facts).toContainEqual({
            category: "USER_DIRECTIVES",
            content: "Preserve Sam's decision & keep <magic-context> wording.",
        });
    });
});
