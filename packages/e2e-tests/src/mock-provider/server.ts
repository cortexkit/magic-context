/**
 * Minimal Anthropic Messages and OpenAI Responses mock server.
 *
 * Accepts POST to `/messages` or `/responses`, captures each request body, and returns
 * a scripted response with full control over input/output/cache token counts.
 *
 * Supports each API's SSE stream plus single-shot JSON responses for direct probes.
 */

/**
 * Gap between keep-alive `ping` events while a `streamHoldMs` answer is held.
 * Shorter than the mock server's own idle timeout (Bun.serve closes a request
 * that sends nothing for 10 s).
 */
import { LatestTurnThinkingValidator } from "./latest-turn-thinking";

const STREAM_PING_INTERVAL_MS = 5_000;

/**
 * Forward the first SSE event of `source` at once, send `ping` events while
 * `holdMs` elapses, then forward the rest. The request stays open the whole time.
 */
function holdAfterFirstEvent(
    source: ReadableStream<Uint8Array>,
    holdMs: number,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const ping = new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n');
    let held = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!held) {
                const first = await reader.read();
                if (first.done) {
                    controller.close();
                    return;
                }
                controller.enqueue(first.value);
                held = true;
                const until = Date.now() + holdMs;
                while (Date.now() < until) {
                    await Bun.sleep(Math.min(STREAM_PING_INTERVAL_MS, until - Date.now()));
                    if (Date.now() < until) controller.enqueue(ping);
                }
                return;
            }
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

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
    /** OpenAI Responses output items. Used only for POST /responses. */
    openaiOutput?: unknown[];
    /** Simulate the Responses API ending at the provider's output-token limit. */
    openaiIncomplete?: boolean;
    /** Stop reason reported to the caller. */
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    /**
     * Token usage reported to the caller — critical for threshold tests.
     * Required unless `error` is set (errors don't report usage).
     */
    usage?: MockUsage;
    /** Delay before responding (simulate slow historian). */
    delayMs?: number;
    /**
     * Anthropic streams only: send the headers and `message_start` at once, then
     * hold the rest of the answer this long, sending a `ping` event every
     * `STREAM_PING_INTERVAL_MS`. Simulates a slow model that keeps its stream
     * alive, so the host's own header and between-chunk timers (300 s each by
     * default) never fire while the answer takes longer than that in total.
     */
    streamHoldMs?: number;
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
    /** Provider-side rejection, recorded before request matchers run. */
    thinkingViolation?: string;
    receivedAt: number;
    /** Exact provider request payload, before JSON parsing. */
    rawBody?: string;
    /** Set when the mock has finished producing the response for this request. */
    responseCompletedAt?: number;
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
    /** Stable caller identity for the provider's latest-turn thinking oracle. */
    thinkingScope?: (body: Record<string, unknown>) => string | undefined;
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
    private misses = 0;
    private thinkingScope?: MockServerOptions["thinkingScope"];
    private thinkingValidator = new LatestTurnThinkingValidator();

    async start(options: MockServerOptions = {}): Promise<{ port: number; baseURL: string }> {
        const port = options.port ?? 0; // 0 = pick any available port
        this.thinkingScope = options.thinkingScope;
        this.server = Bun.serve({
            port,
            // Bind the address advertised to the child. A localhost listener can
            // coexist with an unrelated IPv4 listener on the same port on macOS.
            hostname: "127.0.0.1",
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

    resumeLegacyThinking(scope: string, userTurns: number, returnedThinking: unknown[]): void {
        this.thinkingValidator.resumeLegacy(scope, userTurns, returnedThinking);
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
        this.thinkingValidator = new LatestTurnThinkingValidator();
    }

    private async handle(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;
        const expectedHost = `127.0.0.1:${this.server?.port}`;
        if (url.host !== expectedHost || req.headers.get("host") !== expectedHost) {
            throw new Error(`Off-mock request host: ${req.url}; expected ${expectedHost}`);
        }

        // Accept paths with and without /v1; AI SDK providers differ in how they join baseURL.
        const isMessages = url.pathname === "/messages" || url.pathname === "/v1/messages";
        const isResponses = url.pathname === "/responses" || url.pathname === "/v1/responses";
        const isChat =
            url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions";

        const matched = method === "POST" && (isMessages || isResponses || isChat);
        if (!matched) this.misses++;
        if (process.env.MC_E2E_TRACE_PROVIDER === "1") {
            console.error(`[mock-request] ${JSON.stringify({ url: req.url, method, host: req.headers.get("host"), matched, misses: this.misses })}`);
        }

        if (matched) {
            let body: Record<string, unknown> = {};
            const rawBody = await req.text();
            try {
                body = JSON.parse(rawBody) as Record<string, unknown>;
            } catch {
                body = {};
            }

            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                headers[key] = value;
            });

            const captured: CapturedRequest = {
                receivedAt: Date.now(),
                method,
                path: url.pathname,
                headers,
                body,
                rawBody,
            };
            this.captured.push(captured);

            const scope = isMessages ? this.thinkingScope?.(body) : undefined;
            if (scope !== undefined) {
                const error = this.thinkingValidator.check(scope, body.messages as Array<{ role: string; content: unknown }>);
                if (error) {
                    captured.thinkingViolation = error;
                    captured.responseCompletedAt = Date.now();
                    return Response.json({ type: "error", error: { type: "invalid_request_error", message: error } }, { status: 400 });
                }
            }

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
            // Record completion after any scripted delay. Tests can therefore
            // prove request overlap without making wall-clock claims.
            captured.responseCompletedAt = Date.now();

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
            if (scope !== undefined) this.thinkingValidator.returned(scope, content);

            const respModel =
                scripted.model ??
                (typeof body.model === "string" ? body.model : "mock-model");

            if (isResponses) {
                return this.openAIResponsesResponse(body, scripted, usage, respModel, content);
            }
            if (isChat) {
                return this.openAIChatCompletionsResponse(scripted, usage, respModel);
            }

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
                                // Newer OpenCode/AI SDK builds read the final
                                // cumulative usage from message_delta when
                                // constructing message.updated events. Keep the
                                // same values in message_start above for older
                                // parsers, but repeat them here so threshold-
                                // driven e2e tests continue to exercise the
                                // plugin's scheduler instead of seeing zeros.
                                input_tokens: usage.input_tokens,
                                cache_creation_input_tokens:
                                    usage.cache_creation_input_tokens ?? 0,
                                cache_read_input_tokens:
                                    usage.cache_read_input_tokens ?? 0,
                                output_tokens: usage.output_tokens,
                            },
                        });

                        send("message_stop", { type: "message_stop" });
                        controller.close();
                    },
                });

                const body =
                    scripted.streamHoldMs && scripted.streamHoldMs > 0
                        ? holdAfterFirstEvent(stream, scripted.streamHoldMs)
                        : stream;
                return new Response(body, {
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

    private openAIChatCompletionsResponse(
        scripted: MockResponse,
        usage: MockUsage,
        model: string,
    ): Response {
        const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const text = scripted.text ?? "OK";
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                const send = (payload: Record<string, unknown>) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                };
                send({
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model,
                    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                });
                send({
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                });
                send({
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: {
                        prompt_tokens: usage.input_tokens,
                        completion_tokens: usage.output_tokens,
                        total_tokens: usage.input_tokens + usage.output_tokens,
                    },
                });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }

    private openAIResponsesResponse(
        body: Record<string, unknown>,
        scripted: MockResponse,
        usage: MockUsage,
        model: string,
        anthropicContent: unknown[],
    ): Response {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const output: Record<string, unknown>[] = (scripted.openaiOutput ?? [
            {
                type: "message",
                role: "assistant",
                content: anthropicContent.map((rawBlock) => {
                    const block = rawBlock as { text?: unknown };
                    return {
                        type: "output_text",
                        text: typeof block.text === "string" ? block.text : "",
                        annotations: [],
                        logprobs: [],
                    };
                }),
            },
        ]).map((rawItem, index) => {
            const item = rawItem as Record<string, unknown>;
            return {
                id:
                    item.id ??
                    `${item.type === "reasoning" ? "rs" : item.type === "function_call" ? "fc" : "msg"}_${responseId}_${index}`,
                status: item.status ?? "completed",
                ...item,
            };
        });
        const responseUsage = {
            input_tokens: usage.input_tokens,
            input_tokens_details: {
                cached_tokens: usage.cache_read_input_tokens ?? 0,
            },
            output_tokens: usage.output_tokens,
            output_tokens_details: {
                reasoning_tokens: 0,
            },
            total_tokens: usage.input_tokens + usage.output_tokens,
        };
        const completedResponse = {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: scripted.openaiIncomplete ? "incomplete" : "completed",
            error: null,
            incomplete_details: scripted.openaiIncomplete ? { reason: "max_output_tokens" } : null,
            instructions: null,
            max_output_tokens: null,
            model,
            output,
            parallel_tool_calls: true,
            previous_response_id:
                typeof body.previous_response_id === "string" ? body.previous_response_id : null,
            reasoning: null,
            store: false,
            temperature: 1,
            text: { format: { type: "text" } },
            tool_choice: "auto",
            tools: Array.isArray(body.tools) ? body.tools : [],
            top_p: 1,
            truncation: "disabled",
            usage: responseUsage,
        };

        if (body.stream !== true) {
            return new Response(JSON.stringify(completedResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                const send = (data: Record<string, unknown>) => {
                    const type = String(data.type ?? "message");
                    controller.enqueue(
                        encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
                    );
                };
                send({
                    type: "response.created",
                    sequence_number: 0,
                    response: { ...completedResponse, status: "in_progress", output: [], usage: null },
                });
                let sequenceNumber = 1;
                output.forEach((item, outputIndex) => {
                    send({
                        type: "response.output_item.added",
                        sequence_number: sequenceNumber++,
                        output_index: outputIndex,
                        item: {
                            ...item,
                            ...(item.type === "function_call" ? { arguments: "" } : {}),
                            status: "in_progress",
                        },
                    });
                    if (item.type === "message" && Array.isArray(item.content)) {
                        item.content.forEach((part: unknown, contentIndex: number) => {
                            const contentPart = part as Record<string, unknown>;
                            send({
                                type: "response.content_part.added",
                                sequence_number: sequenceNumber++,
                                item_id: item.id,
                                output_index: outputIndex,
                                content_index: contentIndex,
                                part: { ...contentPart, text: "" },
                            });
                            if (
                                contentPart.type === "output_text" &&
                                typeof contentPart.text === "string"
                            ) {
                                send({
                                    type: "response.output_text.delta",
                                    sequence_number: sequenceNumber++,
                                    item_id: item.id,
                                    output_index: outputIndex,
                                    content_index: contentIndex,
                                    delta: contentPart.text,
                                    logprobs: [],
                                });
                                send({
                                    type: "response.output_text.done",
                                    sequence_number: sequenceNumber++,
                                    item_id: item.id,
                                    output_index: outputIndex,
                                    content_index: contentIndex,
                                    text: contentPart.text,
                                    logprobs: [],
                                });
                            }
                            send({
                                type: "response.content_part.done",
                                sequence_number: sequenceNumber++,
                                item_id: item.id,
                                output_index: outputIndex,
                                content_index: contentIndex,
                                part: contentPart,
                            });
                        });
                    } else if (
                        item.type === "function_call" &&
                        typeof item.arguments === "string"
                    ) {
                        send({
                            type: "response.function_call_arguments.delta",
                            sequence_number: sequenceNumber++,
                            item_id: item.id,
                            output_index: outputIndex,
                            delta: item.arguments,
                        });
                        send({
                            type: "response.function_call_arguments.done",
                            sequence_number: sequenceNumber++,
                            item_id: item.id,
                            output_index: outputIndex,
                            arguments: item.arguments,
                        });
                    }
                    send({
                        type: "response.output_item.done",
                        sequence_number: sequenceNumber++,
                        output_index: outputIndex,
                        item,
                    });
                });
                send({
                    type: scripted.openaiIncomplete ? "response.incomplete" : "response.completed",
                    sequence_number: sequenceNumber,
                    response: completedResponse,
                });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
}
