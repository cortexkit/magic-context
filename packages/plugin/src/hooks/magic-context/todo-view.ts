export interface TodoItem {
    content: string;
    status: string;
    priority: string;
}

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

export function renderTodoBlock(stateJson: string): string | null {
    const todos = parseTodoState(stateJson);
    if (!todos) return null;

    const activeTodos = todos.filter((todo) => !TERMINAL_STATUSES.has(todo.status));
    if (activeTodos.length === 0) return null;

    const lines = activeTodos.map((todo) => `- [${todo.status}] ${escapeXml(todo.content)}`);
    return `\n\n<current-todos>\n${lines.join("\n")}\n</current-todos>`;
}

export function normalizeTodoStateJson(todos: unknown): string | null {
    if (!Array.isArray(todos)) return null;

    const normalized: TodoItem[] = [];
    for (const todo of todos) {
        if (!isTodoItem(todo)) return null;
        normalized.push({
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
        });
    }

    return JSON.stringify(normalized);
}

function parseTodoState(stateJson: string): TodoItem[] | null {
    if (stateJson.length === 0) return null;

    try {
        const parsed = JSON.parse(stateJson);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter(isTodoItem).map((todo) => ({
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
        }));
    } catch {
        return null;
    }
}

function isTodoItem(value: unknown): value is TodoItem {
    if (value === null || typeof value !== "object") return false;
    const todo = value as Record<string, unknown>;
    return (
        typeof todo.content === "string" &&
        typeof todo.status === "string" &&
        typeof todo.priority === "string"
    );
}

function escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
