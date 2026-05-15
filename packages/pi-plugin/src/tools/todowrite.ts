/**
 * Pi-side `todowrite` tool.
 *
 * # Why this exists
 *
 * OpenCode ships a built-in `todowrite` tool that the agent uses to manage
 * work-tracking state. Magic Context captures that state in
 * `session_meta.last_todo_state` via the `tool.execute.after` hook so the
 * synthetic-todowrite injector can resurface it across cache-busts.
 *
 * Pi-coding-agent has NO built-in `todowrite` — Pi treats todo management
 * as an extension concern (see `pi-mono/packages/coding-agent/examples/extensions/todo.ts`
 * for a community example). That means:
 *   1. The Pi LLM won't see a `todowrite` tool unless something registers it.
 *   2. Without registration, the agent can't emit `todowrite` calls, so
 *      synthetic-todowrite injection has nothing to surface.
 *   3. e2e tests can't drive the capture path either.
 *
 * Magic Context provides a built-in `todowrite` to close this parity gap.
 * The tool is intentionally minimal: it accepts the same `{ todos: [...] }`
 * shape OpenCode uses, returns a pretty-printed JSON acknowledgement
 * (matching OpenCode's `todo.ts` output), and lets the message_end capture
 * path in `index.ts` snapshot the args into `session_meta.last_todo_state`.
 *
 * Wire-shape parity verified against:
 *   - OpenCode source: `~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts`
 *   - Synthetic part shape: `packages/plugin/src/hooks/magic-context/todo-view.ts`
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const STATUS_VALUES = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const;
const PRIORITY_VALUES = ["high", "medium", "low"] as const;

const TodoItem = Type.Object({
	content: Type.String({ description: "Brief description of the task" }),
	status: Type.Union(STATUS_VALUES.map((v) => Type.Literal(v))),
	priority: Type.Optional(
		Type.Union(PRIORITY_VALUES.map((v) => Type.Literal(v))),
	),
	id: Type.Optional(
		Type.String({ description: "Optional stable id for the todo" }),
	),
});

const TodowriteParams = Type.Object({
	todos: Type.Array(TodoItem, {
		description:
			"Replace the current task list with this complete set of todos. Include every task you intend to track this turn — pending, in_progress, completed, or cancelled — because the list overwrites previous state.",
	}),
});

type TodowriteParamsT = Static<typeof TodowriteParams>;

const TOOL_DESCRIPTION = [
	"Manage your task list for this session.",
	"",
	"Use this tool to plan multi-step work, track in-flight tasks, and",
	"mark progress as you complete steps. Pass the COMPLETE updated list",
	"of todos every time — this tool replaces the prior list rather than",
	"appending to it.",
	"",
	"Task states:",
	"  - pending: not started yet",
	"  - in_progress: currently working on (limit to ONE task at a time)",
	"  - completed: finished successfully",
	"  - cancelled: no longer needed",
	"",
	"Use this tool proactively for non-trivial work spanning 3+ steps.",
	"Skip it for single-shot answers or trivial 1-2 step tasks.",
].join("\n");

export function createTodowriteTool(): ToolDefinition<typeof TodowriteParams> {
	return {
		name: "todowrite",
		label: "Todos",
		description: TOOL_DESCRIPTION,
		parameters: TodowriteParams,
		async execute(
			_toolCallId,
			params: TodowriteParamsT,
			_signal,
			_onUpdate,
			_ctx,
		) {
			const todos = params.todos ?? [];
			// Output shape matches OpenCode `todo.ts:46-52`: pretty-printed JSON
			// of the full todos array. Magic Context's `tool_execution_start`
			// and `message_end` handlers capture `params.todos` into
			// `session_meta.last_todo_state` directly, so this output is
			// purely for the agent's own visibility on the next turn.
			const completed = todos.filter((t) => t.status === "completed").length;
			const active = todos.length - completed;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(todos, null, 2),
					},
				],
				details: {
					todos,
					title: `${active} todos`,
					truncated: false,
				},
			};
		},
	};
}
