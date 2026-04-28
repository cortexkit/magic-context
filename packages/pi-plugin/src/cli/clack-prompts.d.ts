declare module "@clack/prompts" {
	export function intro(message: string): void;
	export function outro(message: string): void;
	export function note(message: string, title?: string): void;
	export function spinner(): {
		start(message: string): void;
		stop(message: string): void;
	};
	export function isCancel(value: unknown): boolean;
	export const log: {
		info(message: string): void;
		success(message: string): void;
		warn(message: string): void;
		message(message: string): void;
	};
	export function confirm(options: {
		message: string;
		initialValue?: boolean;
	}): Promise<unknown>;
	export function text(options: {
		message: string;
		placeholder?: string;
		initialValue?: string;
		validate?: (value: unknown) => string | undefined;
	}): Promise<unknown>;
	export function select(options: {
		message: string;
		options: { label: string; value: string; hint?: string }[];
	}): Promise<unknown>;
}
