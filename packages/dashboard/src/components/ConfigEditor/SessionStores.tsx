import { createResource, createSignal, For, Show } from "solid-js";
import { getOpencodeStores } from "../../lib/api";
import { STORE_ORIGIN_LABELS, sessionStoreViews, storePathError } from "./session-stores";

/**
 * The user tab's "Session stores" section: every OpenCode store the dashboard
 * reads, where it came from and whether it was found. Only configured rows
 * can be added or removed; they are saved with the rest of the form.
 */
export default function SessionStores(props: {
  /** The saved config text; the store list is read again whenever it changes. */
  savedContent: string;
  configured: string[];
  onChange: (next: string[]) => void;
}) {
  const [stores] = createResource(
    () => props.savedContent,
    () => getOpencodeStores(),
  );
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const views = () => sessionStoreViews(stores.error ? undefined : stores(), props.configured);

  return (
    <div class="config-field config-field-wide">
      <div class="config-field-header">
        <span class="config-field-label">Session Stores</span>
        <span class="config-field-key">dashboard.opencode_db_paths</span>
      </div>
      <span class="config-field-desc">
        The OpenCode session databases the dashboard reads and shows together. Your own OpenCode
        store and the CortexKit runner&apos;s stores are found automatically. Add any other{" "}
        <code>opencode.db</code> file, or the folder that holds one, by its absolute path. The
        dashboard only reads these files.
      </span>
      <Show when={stores.error}>
        <p class="config-table-note config-store-error" role="alert">
          Could not list the session stores: {String(stores.error)}
        </p>
      </Show>
      <div class="config-table-wrap">
        <table class="config-model-table config-store-table">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            <For each={views()}>
              {(view) => (
                <tr>
                  <td>
                    <code class="config-store-path">{view.path}</code>
                  </td>
                  <td>{STORE_ORIGIN_LABELS[view.origin]}</td>
                  <td>
                    <span class={`config-store-status is-${view.tone}`}>{view.status}</span>
                  </td>
                  <td>
                    <Show
                      when={view.configuredIndex !== undefined}
                      fallback={<span class="config-store-fixed">Found automatically</span>}
                    >
                      <button
                        type="button"
                        class="config-icon-btn"
                        aria-label={`Remove session store ${view.path}`}
                        onClick={() =>
                          props.onChange(
                            props.configured.filter((_, index) => index !== view.configuredIndex),
                          )
                        }
                      >
                        ×
                      </button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <form
        class="config-list-row"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = storePathError(draft(), props.configured);
          setError(problem);
          if (!problem) {
            props.onChange([...props.configured, draft().trim()]);
            setDraft("");
          }
        }}
      >
        <input
          class="config-input"
          aria-label="New session store path"
          placeholder="Absolute path to opencode.db or its folder"
          value={draft()}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
        <button type="submit" class="btn sm" disabled={!draft().trim()}>
          + Add
        </button>
      </form>
      <Show when={error()}>
        {(message) => (
          <p class="config-table-note config-store-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <p class="config-table-note">
        Added and removed paths take effect when you save the configuration.
      </p>
    </div>
  );
}
