import type { Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

export type CaptureModel =
	| Model<"openai-completions">
	| Model<"anthropic-messages">;

/** Capture the actual SDK HTTP body after host admission, without contacting a provider. */
export async function captureProviderRequest(args: {
	model: CaptureModel;
	messages: Parameters<typeof convertToLlm>[0];
	systemPrompt: string;
	tools: Context["tools"];
	beforeRequest: (payload: unknown) => unknown | Promise<unknown>;
	signal?: AbortSignal;
}): Promise<string | undefined> {
	let body: string | undefined;
	const context = {
		systemPrompt: args.systemPrompt,
		messages: convertToLlm(args.messages),
		tools: args.tools,
	};
	const options = {
		apiKey: "synthetic-not-a-secret",
		maxTokens: args.model.api === "anthropic-messages" ? 8192 : 1024,
		temperature: 0.25,
		toolChoice: "auto" as const,
		maxRetries: 0,
		signal: args.signal,
		onPayload: args.beforeRequest,
		fetch: Object.assign(
			async (...[_url, init]: Parameters<typeof fetch>) => {
				body = String(init?.body);
				return new Response("synthetic provider error after request capture", {
					status: 400,
				});
			},
			{ preconnect: () => {} },
		),
	};
	const response =
		args.model.api === "anthropic-messages"
			? streamAnthropic(args.model, context, { ...options, effort: "high" })
			: streamOpenAI(args.model, context, options);
	await response.result().catch(() => {});
	return body;
}
