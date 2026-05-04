/**
 * Minimal Anthropic-compatible mock server.
 *
 * Accepts POST to /messages (matching `${baseURL}/messages` path used by @ai-sdk/anthropic),
 * captures each request body, and returns a scripted response with full control over
 * input/output/cache_read/cache_write token counts.
 *
 * Supports both Anthropic Messages SSE streaming (OpenCode's default transport) and
 * single-shot JSON responses (useful for direct unit-level probing of the mock).
 */

export interface MockUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

export interface MockResponse {
    /** Simple text response. Will be converted into an Anthropic content array. */
    text?: string;
    /** Override content block array directly (for tool calls, multi-block). */
    content?: unknown[];
    /** Stop reason reported to the caller. */
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    /**
     * Token usage reported to the caller — critical for threshold tests.
     * Required unless `error` is set (errors don't report usage).
     */
    usage?: MockUsage;
    /** Delay before responding (simulate slow historian). */
    delayMs?: number;
    /** Optional model name echoed back in the response. Defaults to request's model. */
    model?: string;
    /**
     * Return an error response instead of an assistant message.
     * Use this to simulate provider-side failures like context overflow,
     * rate limits, and auth errors. The harness emits an Anthropic-shaped
     * error body with the given HTTP status and error.type/message. These
     * errors are what `parseAPICallError` in OpenCode (and the overflow
     * detector in magic-context) match against.
     */
    error?: {
        /** HTTP status code (e.g. 400 for overflow, 413 for payload too large). */
        status: number;
        /** Anthropic error.type value (e.g. "invalid_request_error"). */
        type: string;
        /** Human-readable error message — regex-matched for overflow detection. */
        message: string;
    };
}

export interface CapturedRequest {
    receivedAt: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
        system?: unknown;
        tools?: unknown;
        [k: string]: unknown;
    };
}

export interface MockServerOptions {
    port?: number;
}

/**
 * Route predicate — receives the captured request body and returns a MockResponse
 * to use for THIS request, or null to skip to the next matcher / default.
 *
 * Matchers run in insertion order. First match wins. If all matchers return null,
 * the main queue is consulted, then defaultResponse.
 *
 * Typical use: route historian requests (by system-prompt keyword) to a slow/custom
 * response while leaving the main agent on the default fast response.
 */
export type RequestMatcher = (
    body: Record<string, unknown>,
    headers: Record<string, string>,
) => MockResponse | null;

export class MockProvider {
    private server: ReturnType<typeof Bun.serve> | null = null;
    private responses: MockResponse[] = [];
    private captured: CapturedRequest[] = [];
    private defaultResponse: MockResponse | null = null;
    private matchers: RequestMatcher[] = [];

    async start(options: MockServerOptions = {}): Promise<{ port: number; baseURL: string }> {
        const port = options.port ?? 0; // 0 = pick any available port
        this.server = Bun.serve({
            port,
            fetch: async (req) => this.handle(req),
        });
        const actualPort = this.server.port ?? 0;
        if (!actualPort) throw new Error("mock server failed to bind a port");
        return { port: actualPort, baseURL: `http://127.0.0.1:${actualPort}` };
    }

    async stop(): Promise<void> {
        if (this.server) {
            this.server.stop(true);
            this.server = null;
        }
    }

    /** Queue a list of responses (consumed in order per request). */
    script(responses: MockResponse[]): void {
        this.responses = [...responses];
    }

    /** Set a default response to return when the queue is empty. */
    setDefault(response: MockResponse): void {
        this.defaultResponse = response;
    }

    /** Append a single response to the queue. */
    enqueue(response: MockResponse): void {
        this.responses.push(response);
    }

    /**
     * Register a request matcher. Matchers run in order; first non-null return
     * wins. If none match, the main queue and defaultResponse are consulted.
     */
    addMatcher(matcher: RequestMatcher): void {
        this.matchers.push(matcher);
    }

    /** All captured requests, in order. */
    requests(): CapturedRequest[] {
        return [...this.captured];
    }

    /** Most recent request, or null if none. */
    lastRequest(): CapturedRequest | null {
        return this.captured[this.captured.length - 1] ?? null;
    }

    /** Clear queue, captured requests, matchers, and default response. */
    reset(): void {
        this.responses = [];
        this.captured = [];
        this.defaultResponse = null;
        this.matchers = [];
    }

    private async handle(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;

        // Accept both /messages and /v1/messages (depending on how baseURL is configured).
        const isMessages = url.pathname === "/messages" || url.pathname === "/v1/messages";

        if (method === "POST" && isMessages) {
            let body: Record<string, unknown> = {};
            try {
                body = (await req.json()) as Record<string, unknown>;
            } catch {
                body = {};
            }

            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                headers[key] = value;
            });

            this.captured.push({
                receivedAt: Date.now(),
                method,
                path: url.pathname,
                headers,
                body,
            });

            // Matcher routing: first-match-wins. Matchers can return tailored
            // responses based on request body (e.g. slow down historian calls).
            let matcherResponse: MockResponse | null = null;
            for (const matcher of this.matchers) {
                const resp = matcher(body, headers);
                if (resp !== null) {
                    matcherResponse = resp;
                    break;
                }
            }
            const scripted = matcherResponse ?? this.responses.shift() ?? this.defaultResponse;
            if (!scripted) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: { type: "mock_error", message: "No scripted response available" },
                    }),
                    {
                        status: 500,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            if (scripted.delayMs && scripted.delayMs > 0) {
                await Bun.sleep(scripted.delayMs);
            }

            // Error response: emit an Anthropic-shaped error body with the
            // requested HTTP status. This bypasses the SSE/streaming path
            // because Anthropic itself returns non-SSE JSON errors even when
            // stream=true was requested.
            if (scripted.error) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: scripted.error.type,
                            message: scripted.error.message,
                        },
                    }),
                    {
                        status: scripted.error.status,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            const usage = scripted.usage;
            if (!usage) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "mock_error",
                            message: "MockResponse requires `usage` or `error`",
                        },
                    }),
                    { status: 500, headers: { "content-type": "application/json" } },
                );
            }

            const content =
                scripted.content ??
                [{ type: "text", text: scripted.text ?? "OK" }];

            const respModel =
                scripted.model ??
                (typeof body.model === "string" ? body.model : "mock-model");

            const wantsStream = body.stream === true;
            const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

            if (wantsStream) {
                // Emit a minimal but complete Anthropic messages SSE sequence.
                // Events: message_start → content_block_start → content_block_delta(s) →
                //         content_block_stop → message_delta (with final usage) → message_stop.
                // The @ai-sdk/anthropic client consumes this standard order to reconstruct
                // the full response including token usage counts we scripted.
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const send = (event: string, data: Record<string, unknown>) => {
                            controller.enqueue(
                                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                            );
                        };

                        send("message_start", {
                            type: "message_start",
                            message: {
                                id: messageId,
                                type: "message",
                                role: "assistant",
                                model: respModel,
                                content: [],
                                stop_reason: null,
                                stop_sequence: null,
                                usage: {
                                    input_tokens: usage.input_tokens,
                                    output_tokens: 0,
                                    cache_creation_input_tokens:
                                        usage.cache_creation_input_tokens ?? 0,
                                    cache_read_input_tokens:
                                        usage.cache_read_input_tokens ?? 0,
                                },
                            },
                        });

                        // Emit each content block from the scripted `content` array.
                        content.forEach((block: unknown, index: number) => {
                            const blk = block as {
                                type?: string;
                                text?: string;
                                thinking?: string;
                                signature?: string;
                                data?: string;
                            };
                            const blockType = blk.type ?? "text";

                            if (blockType === "text") {
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: { type: "text", text: "" },
                                });
                                send("content_block_delta", {
                                    type: "content_block_delta",
                                    index,
                                    delta: { type: "text_delta", text: blk.text ?? "" },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "thinking") {
                                // Real Anthropic streams thinking as:
                                // 1. content_block_start { content_block: { type: "thinking", thinking: "" } }
                                // 2. content_block_delta { delta: { type: "thinking_delta", thinking: "..." } }
                                // 3. content_block_delta { delta: { type: "signature_delta", signature: "..." } }
                                // 4. content_block_stop
                                // @ai-sdk/anthropic reconstructs the reasoning part from these deltas.
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: { type: "thinking", thinking: "" },
                                });
                                if (blk.thinking) {
                                    send("content_block_delta", {
                                        type: "content_block_delta",
                                        index,
                                        delta: {
                                            type: "thinking_delta",
                                            thinking: blk.thinking,
                                        },
                                    });
                                }
                                if (blk.signature) {
                                    send("content_block_delta", {
                                        type: "content_block_delta",
                                        index,
                                        delta: {
                                            type: "signature_delta",
                                            signature: blk.signature,
                                        },
                                    });
                                }
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "redacted_thinking") {
                                // Redacted thinking carries opaque `data` in the start event;
                                // no deltas are emitted — the full payload arrives up front.
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: {
                                        type: "redacted_thinking",
                                        data: blk.data ?? "",
                                    },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else if (blockType === "tool_use") {
                                const toolBlock = block as {
                                    type: "tool_use";
                                    id?: string;
                                    name?: string;
                                    input?: Record<string, unknown>;
                                };
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: {
                                        type: "tool_use",
                                        id: toolBlock.id ?? `toolu_${index}`,
                                        name: toolBlock.name ?? "mock_tool",
                                        input: {},
                                    },
                                });
                                send("content_block_delta", {
                                    type: "content_block_delta",
                                    index,
                                    delta: {
                                        type: "input_json_delta",
                                        partial_json: JSON.stringify(toolBlock.input ?? {}),
                                    },
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            } else {
                                // Pass through other non-text blocks as-is (tool_use, etc.)
                                send("content_block_start", {
                                    type: "content_block_start",
                                    index,
                                    content_block: block,
                                });
                                send("content_block_stop", {
                                    type: "content_block_stop",
                                    index,
                                });
                            }
                        });

                        send("message_delta", {
                            type: "message_delta",
                            delta: {
                                stop_reason: scripted.stop_reason ?? "end_turn",
                                stop_sequence: null,
                            },
                            usage: {
                                output_tokens: usage.output_tokens,
                            },
                        });

                        send("message_stop", { type: "message_stop" });
                        controller.close();
                    },
                });

                return new Response(stream, {
                    status: 200,
                    headers: {
                        "content-type": "text/event-stream",
                        "cache-control": "no-cache",
                        connection: "keep-alive",
                    },
                });
            }

            // Non-streaming fallback — rarely used by OpenCode but kept for direct tests.
            const responseBody = {
                id: messageId,
                type: "message",
                role: "assistant",
                model: respModel,
                content,
                stop_reason: scripted.stop_reason ?? "end_turn",
                stop_sequence: null,
                usage: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                },
            };

            return new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }

        // Unknown path — return 404
        return new Response(JSON.stringify({ error: "not_found", path: url.pathname }), {
            status: 404,
            headers: { "content-type": "application/json" },
        });
    }
}
