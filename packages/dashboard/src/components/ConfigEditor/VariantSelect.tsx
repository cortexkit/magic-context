import { qualifierOptions } from "./variant-options";

export { qualifierOptions } from "./variant-options";

import type { Harness } from "./harness-model-data";
import SearchPicker from "./SearchPicker";

export default function VariantSelect(props: {
  harness: Harness;
  model: string | undefined;
  variants?: Record<string, string[]>;
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const options = () => qualifierOptions(props.harness, props.model, props.variants);
  return (
    <SearchPicker
      label={props.label}
      value={props.value}
      options={options().values.map((value) => ({ value, label: value }))}
      // Only OpenCode has open-ended variant names; Pi/OMP thinking levels are schema enums.
      allowCustom={!options().known && props.harness === "opencode"}
      onChange={props.onChange}
    />
  );
}
