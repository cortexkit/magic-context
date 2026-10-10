import { createEffect, createSignal, createUniqueId, For, Index, Show } from "solid-js";
import {
  DEFAULT_PROTECTED_TOOLS,
  overridingRow,
  type ProtectedToolRow,
  protectedToolRowErrors,
  protectedToolRows,
  protectedToolsConfig,
} from "./protected-tools";

/**
 * Table editor for `protected_tools`: read-only rows for the built-in defaults,
 * then one editable row per configured tool. Invalid rows stay on screen with
 * an inline message and are not written to the form until they are fixed.
 */
export default function ProtectedTools(props: {
  value: unknown;
  onChange: (value: Record<string, number> | undefined) => void;
}) {
  const id = createUniqueId();
  const [rows, setRows] = createSignal<ProtectedToolRow[]>(protectedToolRows(props.value));
  const errors = () => protectedToolRowErrors(rows());
  let table!: HTMLTableElement;
  // The value this editor last wrote. Any other incoming value came from
  // outside (raw JSONC tab, reload, scope switch) and replaces the rows.
  let written = JSON.stringify(props.value);
  createEffect(() => {
    const incoming = JSON.stringify(props.value);
    if (incoming !== written) {
      written = incoming;
      setRows(protectedToolRows(props.value));
    }
  });

  const commit = (next: ProtectedToolRow[]) => {
    setRows(next);
    const value = protectedToolsConfig(next);
    if (value === null) return;
    written = JSON.stringify(value);
    props.onChange(value);
  };
  const edit = (index: number, patch: Partial<ProtectedToolRow>) =>
    commit(rows().map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const add = () => {
    commit([...rows(), { name: "", count: "1" }]);
    queueMicrotask(() =>
      table.querySelector<HTMLInputElement>(`tr[data-row="${rows().length - 1}"] input`)?.focus(),
    );
  };

  return (
    <div class="config-list-editor protected-tools">
      <table ref={table} class="config-route-table protected-tools-table">
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Keep newest</th>
            <th scope="col">
              <span class="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={Object.entries(DEFAULT_PROTECTED_TOOLS)}>
            {([name, count]) => (
              <tr class="protected-tools-default">
                <td class="mono">{name}</td>
                <td>
                  keep {count}{" "}
                  <span class="protected-tools-default-note">
                    {overridingRow(rows(), name) ? "(default, changed below)" : "(default)"}
                  </span>
                </td>
                <td />
              </tr>
            )}
          </For>
          <Index each={rows()}>
            {(row, index) => {
              const error = () => errors()[index];
              const errorId = `${id}-error-${index}`;
              return (
                <>
                  <tr data-row={index}>
                    <td>
                      <input
                        class="config-input"
                        aria-label={`Tool name, row ${index + 1}`}
                        aria-invalid={error()?.name ? "true" : undefined}
                        aria-describedby={error() ? errorId : undefined}
                        placeholder="Tool name, e.g. read"
                        spellcheck={false}
                        value={row().name}
                        onInput={(event) => edit(index, { name: event.currentTarget.value })}
                      />
                    </td>
                    <td>
                      <input
                        class="config-input"
                        type="number"
                        min={0}
                        step={1}
                        aria-label={`Keep newest results, row ${index + 1}`}
                        aria-invalid={error()?.count ? "true" : undefined}
                        aria-describedby={error() ? errorId : undefined}
                        value={row().count}
                        onInput={(event) => edit(index, { count: event.currentTarget.value })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        class="config-icon-btn"
                        aria-label={`Remove ${row().name.trim() || `row ${index + 1}`}`}
                        onClick={() => commit(rows().filter((_, i) => i !== index))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                  <Show when={error()}>
                    {(problem) => (
                      <tr class="protected-tools-error-row">
                        <td colSpan={3}>
                          <p id={errorId} class="protected-tools-error" role="alert">
                            Not saved until fixed:{" "}
                            {[problem().name, problem().count].filter(Boolean).join(" ")}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Show>
                </>
              );
            }}
          </Index>
        </tbody>
      </table>
      <Show when={rows().length === 0}>
        <p class="config-table-note">
          No custom rows, so only the defaults above apply. For example, add <code>read</code> with
          2 to always keep the newest 2 <code>read</code> results.
        </p>
      </Show>
      <button type="button" class="btn sm" onClick={add}>
        + Add tool
      </button>
    </div>
  );
}
