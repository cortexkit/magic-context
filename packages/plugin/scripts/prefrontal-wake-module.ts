/**
 * Chooses the subc module that delivers the monitoring scripts' wakes.
 *
 * The module that delivers agent messages is being renamed from
 * `prefrontal-core` to `prefrontal`. Until every daemon has the new name, a
 * script reads the daemon's module catalog and sends to `prefrontal` when the
 * catalog lists it, and to `prefrontal-core` otherwise.
 *
 * The catalog is read up front instead of trying `prefrontal` and falling back
 * when the route is refused. The subc client treats an `unknown_module` route
 * refusal as a module that is still starting and retries it for up to 30
 * seconds, so a fallback after that refusal would delay every wake by 30
 * seconds on a daemon that has only `prefrontal-core`.
 */

export const PREFRONTAL_MODULE_ID = "prefrontal";
export const LEGACY_PREFRONTAL_MODULE_ID = "prefrontal-core";

/** The part of a subc client that lists the modules the daemon knows about. */
export interface ModuleCatalogReader {
    catalogList?(): Promise<readonly { module_id: string }[]>;
}

/**
 * Returns `prefrontal` when the daemon's catalog lists it, otherwise
 * `prefrontal-core`. A catalog read that fails is passed on to the caller, so
 * the wake fails instead of guessing which name this daemon uses.
 */
export async function resolvePrefrontalModuleId(client: ModuleCatalogReader): Promise<string> {
    if (!client.catalogList) {
        throw new Error("this subc client cannot read the module catalog, so the wake module cannot be chosen");
    }
    const modules = await client.catalogList();
    return modules.some((entry) => entry.module_id === PREFRONTAL_MODULE_ID)
        ? PREFRONTAL_MODULE_ID
        : LEGACY_PREFRONTAL_MODULE_ID;
}
