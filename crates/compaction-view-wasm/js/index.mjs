// The compaction view library for JavaScript runners (Bun and Node).
//
// The WebAssembly module exports one function, `cv_call(function, input)`,
// which runs exactly the Rust library's `compaction_view::vectors::call`:
// the render plan, the rule check, reply cleaning, tag numbering and every
// checksum, computed by the same code the compaction provider uses. This file
// only moves bytes across the boundary.
//
//   import { load } from "./index.mjs";
//   const view = await load();
//   const answer = view.call("plan", { entries, edits });
//   // answer.ok, answer.refused or answer.error
//
// `load()` reads `compaction_view.wasm` next to this file; pass the bytes
// yourself to load it from elsewhere.

import { readFile } from "node:fs/promises";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Load the module and return `{ call(functionName, input) }`. */
export async function load(bytes) {
	const wasm =
		bytes ?? (await readFile(new URL("./compaction_view.wasm", import.meta.url)));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const { memory, cv_alloc, cv_free, cv_call } = instance.exports;

	// Copy `bytes` into a buffer the module owns; returns [address, length].
	function write(data) {
		const pointer = cv_alloc(data.length);
		new Uint8Array(memory.buffer, pointer, data.length).set(data);
		return [pointer, data.length];
	}

	return {
		/**
		 * Call a library function by name with a JSON-serializable input.
		 * Returns `{ ok }`, `{ refused }` for a view the function refuses, or
		 * `{ error }` for an unknown function or malformed input.
		 */
		call(functionName, input) {
			const [namePointer, nameLength] = write(encoder.encode(functionName));
			const [inputPointer, inputLength] = write(
				encoder.encode(JSON.stringify(input)),
			);
			try {
				const packed = cv_call(namePointer, nameLength, inputPointer, inputLength);
				// The answer's address is in the high 32 bits, its length in the
				// low 32 bits.
				const pointer = Number(packed >> 32n);
				const length = Number(packed & 0xffffffffn);
				try {
					// Read only after the call: it may have grown the memory.
					const text = decoder.decode(
						new Uint8Array(memory.buffer, pointer, length),
					);
					return JSON.parse(text);
				} finally {
					cv_free(pointer, length);
				}
			} finally {
				cv_free(namePointer, nameLength);
				cv_free(inputPointer, inputLength);
			}
		},
	};
}
