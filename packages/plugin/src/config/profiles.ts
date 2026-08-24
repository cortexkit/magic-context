import { ConfigProfilesSchema } from "./schema/magic-context";

export interface ProfileResolution {
    /** User config minus the profile declarations and selector. */
    userBase: Record<string, unknown>;
    /** Project config minus the profile declarations and selector. */
    projectBase: Record<string, unknown>;
    /** The validated user-owned overlay for the active profile, if any. */
    overlay: Record<string, unknown>;
    /** The selected profile name, absent when no valid profile is active. */
    activeProfile?: string;
    warnings: string[];
}

interface ProfileSelection {
    declared: boolean;
    name?: string;
}

function withoutProfileFields(raw: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...raw };
    delete copy.profile;
    delete copy.profiles;
    return copy;
}

function readProfileSelection(raw: Record<string, unknown>): ProfileSelection {
    if (!Object.hasOwn(raw, "profile")) return { declared: false };
    const value = raw.profile;
    if (typeof value !== "string") return { declared: true };
    const name = value.trim();
    return name.length > 0 ? { declared: true, name } : { declared: true };
}

/**
 * Resolve the user-owned profile overlay without retaining any process-global
 * selection state. Callers merge `userBase`, `overlay`, then `projectBase` for
 * every project load, so a Pi /cd or OpenCode multi-root session cannot borrow
 * another repository's selected profile.
 */
export function resolveConfigProfile(args: {
    userRaw: Record<string, unknown>;
    projectRaw: Record<string, unknown>;
}): ProfileResolution {
    const warnings: string[] = [];
    const userSelection = readProfileSelection(args.userRaw);
    const projectSelection = readProfileSelection(args.projectRaw);
    const selection = projectSelection.name
        ? { name: projectSelection.name, source: "project" }
        : userSelection.name
          ? { name: userSelection.name, source: "user" }
          : undefined;

    if (projectSelection.declared && !projectSelection.name) {
        warnings.push(
            "Ignoring invalid profile selection from project config; expected a non-empty string.",
        );
    }
    if (!projectSelection.declared && userSelection.declared && !userSelection.name) {
        warnings.push(
            "Ignoring invalid profile selection from user config; expected a non-empty string.",
        );
    }

    let profiles: Record<string, Record<string, unknown>> = {};
    if (Object.hasOwn(args.userRaw, "profiles")) {
        const parsed = ConfigProfilesSchema.safeParse(args.userRaw.profiles);
        if (parsed.success) {
            profiles = parsed.data as Record<string, Record<string, unknown>>;
        } else {
            warnings.push(
                "Ignoring profiles from user config: invalid profile configuration; profiles may contain only historian/dreamer harness model blocks and sidekick model-selection fields.",
            );
        }
    }

    if (!selection) {
        return {
            userBase: withoutProfileFields(args.userRaw),
            projectBase: withoutProfileFields(args.projectRaw),
            overlay: {},
            warnings,
        };
    }

    const overlay = profiles[selection.name];
    if (!overlay) {
        warnings.push(
            `Unknown profile "${selection.name}" selected by ${selection.source} config; using base config without a profile.`,
        );
        return {
            userBase: withoutProfileFields(args.userRaw),
            projectBase: withoutProfileFields(args.projectRaw),
            overlay: {},
            warnings,
        };
    }

    return {
        userBase: withoutProfileFields(args.userRaw),
        projectBase: withoutProfileFields(args.projectRaw),
        overlay,
        activeProfile: selection.name,
        warnings,
    };
}
