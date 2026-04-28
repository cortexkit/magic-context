import {
	confirm as clackConfirm,
	text as clackText,
	intro,
	isCancel,
	log,
	note,
	outro,
	select,
	spinner,
} from "@clack/prompts";

export interface SelectOption {
	label: string;
	value: string;
	recommended?: boolean;
}

export interface PromptLog {
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	message(message: string): void;
}

export interface PromptSpinner {
	start(message: string): void;
	stop(message: string): void;
}

export interface PromptIO {
	intro(message: string): void;
	outro(message: string): void;
	note(message: string, title?: string): void;
	log: PromptLog;
	spinner(): PromptSpinner;
	confirm(message: string, defaultYes?: boolean): Promise<boolean>;
	text(
		message: string,
		options?: {
			placeholder?: string;
			initialValue?: string;
			validate?: (value: string) => string | undefined;
		},
	): Promise<string>;
	selectOne(message: string, options: SelectOption[]): Promise<string>;
}

function handleCancel(value: unknown): void {
	if (isCancel(value)) {
		log.warn("Setup cancelled.");
		process.exit(0);
	}
}

export const promptIO: PromptIO = {
	intro(message) {
		intro(message);
	},
	outro(message) {
		outro(message);
	},
	note(message, title) {
		note(message, title);
	},
	log: {
		info(message) {
			log.info(message);
		},
		success(message) {
			log.success(message);
		},
		warn(message) {
			log.warn(message);
		},
		message(message) {
			log.message(message);
		},
	},
	spinner() {
		const underlying = spinner();
		return {
			start(message) {
				underlying.start(message);
			},
			stop(message) {
				underlying.stop(message);
			},
		};
	},
	async confirm(message, defaultYes = true) {
		const result = await clackConfirm({ message, initialValue: defaultYes });
		handleCancel(result);
		return result as boolean;
	},
	async text(message, options = {}) {
		const result = await clackText({
			message,
			placeholder: options.placeholder,
			initialValue: options.initialValue,
			validate: options.validate
				? (value) => {
						const str = typeof value === "string" ? value : "";
						return options.validate?.(str);
					}
				: undefined,
		});
		handleCancel(result);
		return result as string;
	},
	async selectOne(message, options) {
		const result = await select({
			message,
			options: options.map((option) => ({
				label: option.recommended
					? `${option.label} (recommended)`
					: option.label,
				value: option.value,
				hint: option.recommended ? "recommended" : undefined,
			})),
		});
		handleCancel(result);
		return result as string;
	},
};
