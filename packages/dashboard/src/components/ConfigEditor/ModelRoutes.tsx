import { createSignal, Index, Show } from "solid-js";
import ModelSelect from "./ModelSelect";
import { editRoute } from "./route-edit";

export { editRoute } from "./route-edit";

export default function ModelRoutes(props: {
  value: Record<string, unknown> | undefined;
  models: string[];
  onChange: (value: Record<string, unknown> | undefined) => void;
}) {
  const [adding, setAdding] = createSignal(false);
  const [error, setError] = createSignal("");
  const update = (previous: string, route: string, preset: unknown) => {
    // biome-ignore lint/suspicious/noPrototypeBuiltins: The dashboard targets ES2021, before Object.hasOwn.
    if (route !== previous && Object.prototype.hasOwnProperty.call(props.value ?? {}, route)) {
      setError(`A route for ${route} already exists.`);
      return;
    }
    setError("");
    const next = editRoute(props.value ?? {}, previous, route, preset);
    props.onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div class="config-list-editor">
      <table class="config-route-table">
        <thead>
          <tr>
            <th>Route</th>
            <th>Preset</th>
            <th>
              <span class="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <Index each={Object.entries(props.value ?? {})}>
            {(entry) => (
              <tr>
                <td>
                  <ModelSelect
                    label={`Route ${entry()[0]}`}
                    models={props.models}
                    value={entry()[0]}
                    onChange={(route) => update(entry()[0], route, entry()[1])}
                  />
                </td>
                <td>
                  <select
                    class="config-input"
                    aria-label={`Preset for ${entry()[0]}`}
                    value={String(entry()[1])}
                    onChange={(event) => update(entry()[0], entry()[0], event.currentTarget.value)}
                  >
                    <option value="full">full</option>
                    <option value="light">light</option>
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    class="config-icon-btn"
                    aria-label={`Remove route ${entry()[0]}`}
                    onClick={() => update(entry()[0], "", entry()[1])}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
      <Show when={error()}>
        <p role="alert" class="config-table-note">
          {error()}
        </p>
      </Show>
      <Show when={adding()}>
        <ModelSelect
          models={props.models}
          value={undefined}
          placeholder="Select model or type provider/*"
          onChange={(route) => {
            if (route) update("", route, "full");
            setAdding(false);
          }}
        />
      </Show>
      <button type="button" class="btn sm" onClick={() => setAdding(!adding())}>
        {adding() ? "Cancel" : "+ Add route"}
      </button>
    </div>
  );
}
