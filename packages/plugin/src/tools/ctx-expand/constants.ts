export const CTX_EXPAND_DESCRIPTION =
    "Decompress a compartment range to see the original conversation transcript. " +
    "Use start/end from <compartment start=N end=M> attributes. " +
    "Returns the compacted U:/A: transcript for that message range, capped at ~15K tokens.";

export const CTX_EXPAND_TOKEN_BUDGET = 15_000;
