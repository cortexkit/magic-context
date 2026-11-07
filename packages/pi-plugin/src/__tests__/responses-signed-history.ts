export const responsesModel = {
	api: "openai-responses",
	provider: "openai",
	id: "gpt-5",
	name: "GPT-5",
	baseUrl: "http://responses.invalid/v1",
	input: ["text"],
	identity: { class: "gpt", model: "gpt-5" },
	compat: {},
	contextWindow: 200_000,
	maxTokens: 16_000,
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function signedHistory(text = "§42§ Hello", id = "msg_old") {
	return {
		role: "assistant",
		api: responsesModel.api,
		provider: responsesModel.provider,
		model: responsesModel.id,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 100,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 101,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{
				type: "text",
				text,
				textSignature: JSON.stringify({ v: 1, id, phase: "final_answer" }),
			},
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: responsesModel.provider,
			dt: true,
			items: [
				{
					type: "message",
					role: "assistant",
					id,
					phase: "final_answer",
					status: "completed",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			],
		},
	};
}
