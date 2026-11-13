interface Decision {
	message_id: string;
	ts_ms: number;
}

interface Turn {
	start: number;
	end: number;
	assistantEntryIds?: readonly string[];
}

/** Pi binds a decision to the assistant entry on a later context pass. */
export function decisionMatchesTurn(row: Decision, turn: Turn): boolean {
	if (turn.assistantEntryIds !== undefined)
		return turn.assistantEntryIds.includes(row.message_id);
	return row.ts_ms >= turn.start && row.ts_ms <= turn.end;
}
