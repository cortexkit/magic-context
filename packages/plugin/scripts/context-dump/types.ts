export interface DumpMessageInfo {
	id?: string
	role?: string
	sessionID?: string
	error?: MsgError
	[key: string]: unknown
}

export interface MsgError {
	name: string;
	data: unknown[];
}
export interface DumpMessage {
	info: DumpMessageInfo
	parts: unknown[]
}

export interface ContextTagRow {
	messageId: string
	type: "message" | "tool" | "file"
	status: "active" | "dropped" | "compacted"
	tagNumber: number
}

export interface TransformDiagnostics {
	exactMatchCount: number
	ordinalFallbackCount: number
	missingDroppedTags: ContextTagRow[]
	compartmentInjection?: {
		injected: boolean
		compartmentCount: number
		compartmentEndMessage: number
		skippedVisibleMessages: number
	}
}

export interface DumpFilePayload {
	session_id: string
	timestamp: string
	message_count: number
	original: {
		total_chars: number
		total_tokens: number
		messages: DumpMessage[]
	}
	transformed: {
		total_chars: number
		total_tokens: number
		messages: DumpMessage[]
	}
	compression_ratio: string
	per_message_sizes: Array<{
		id: string
		role: string
		original_chars: number
		transformed_chars: number
	}>
	per_message_cache: Array<{
		id: string
		role: string
		total: number
		input: number
		output: number
		cache_read: number
		cache_write: number
		cache_bust: boolean
	}>
	transform_diagnostics: TransformDiagnostics
	pending_ops: PendingOpRow[]
}
export interface DumpMessageSize {
	id: string
	role: string
	original_chars: number
	transformed_chars: number
}

export interface DumpMessageCacheEntry {
	id: string
	role: string
	total: number
	input: number
	output: number
	cache_read: number
	cache_write: number
	cache_bust: boolean
	time_completed: number | null
	part_types: string
}
export interface DumpStats {
	messageCount: number
	originalTotalChars: number
	transformedTotalChars: number
	originalTotalTokens: number
	transformedTotalTokens: number
	compressionRatio: string
	perMessageSizes: DumpMessageSize[]
	perMessageCache: DumpMessageCacheEntry[]
}

export interface PendingOpRow {
	tagNumber: number
	operation: "drop"
	status: string
}

export interface SourceContentRow {
	tagNumber: number
	content: string
}
