import { MockProvider } from "../src/mock-provider/server";
import { buildMockHistorianPayload, historianRangeInRequest } from "../src/mock-historian";

export const SCRIPTED_COMMAND = `cat PLAYBOOK.md
mkdir -p project
cat > project/parser.ts <<'EOF'
export const parse = (s: string) => s.split('+').map(Number);
EOF
cat > project/evaluator.ts <<'EOF'
import { parse } from './parser';
export const evaluate = (s: string) => parse(s).reduce((a, b) => a + b, 0);
EOF
cat > project/cli.ts <<'EOF'
import { evaluate } from './evaluator';
console.log(evaluate(Bun.argv[2] ?? '1+2'));
EOF
cat > project/evaluator.test.ts <<'EOF'
import { expect, test } from 'bun:test';
import { evaluate } from './evaluator';
test('addition', () => expect(evaluate('1+2')).toBe(3));
EOF
bun build project/cli.ts --target=bun --outfile=project/cli.js
bun test project/evaluator.test.ts
cat project/parser.ts project/evaluator.ts project/cli.ts project/evaluator.test.ts
awk 'BEGIN { for (i=0;i<280;i++) print "fixture detail " i ": parser evaluator test coverage precedence variables diagnostics readback" }'
`;

/** The shared mock supplies hidden-agent text. Its chat adapter has no tool-call
 * or cache-read support, so requests exposing the shell tool are scripted here. */
export async function fakeProvider() {
    const mock = new MockProvider();
    const backing = await mock.start();
    mock.setDefault({ text: "fixture title", usage: { input_tokens: 100, output_tokens: 10 } });
    mock.addMatcher((body) => {
        const range = historianRangeInRequest(body);
        return range ? { text: buildMockHistorianPayload({ ...range, title: "CLI batch",
            body: "Read PLAYBOOK.md, wrote parser/evaluator/CLI/tests, built and tested addition using shell heredocs." }),
            usage: { input_tokens: 1000, output_tokens: 300 } } : null;
    });
    let steps = 0;
    return {
        mock,
        async respond(body: Record<string, unknown>): Promise<Response> {
            const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
            const shell = tools?.find((tool) => tool.function?.name === "shell");
            if (!shell || historianRangeInRequest(body)) {
                return fetch(`${backing.baseURL}/chat/completions`, { method: "POST",
                    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            }
            steps++;
            const done = steps % 6 === 0;
            const delta = done ? { content: "Batch checkpoint complete; continue the batch for more work." } : {
                tool_calls: [{ index: 0, id: `call_886_${steps}`, type: "function", function: {
                    name: "shell", arguments: JSON.stringify({ command: SCRIPTED_COMMAND }),
                } }],
            };
            const cached = steps % 3 === 1 ? 49152 : 261120;
            const usage = { prompt_tokens: 268880, completion_tokens: 600,
                total_tokens: 269480, prompt_tokens_details: { cached_tokens: cached },
                prompt_cache_hit_tokens: cached, prompt_cache_miss_tokens: 268880 - cached };
            const chunk = (delta: unknown, finish_reason: string | null, extra = {}) => `data: ${JSON.stringify({
                id: `chatcmpl-886-${steps}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
                model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }], ...extra,
            })}\n\n`;
            return new Response(chunk({ role: "assistant", content: "" }, null)
                + chunk(delta, null) + chunk({}, done ? "stop" : "tool_calls", { usage }) + "data: [DONE]\n\n",
                { headers: { "Content-Type": "text/event-stream" } });
        },
    };
}
