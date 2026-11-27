import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { e2eTempRoot, snapshotRootEnvironment } from "./root-environment";

// GitHub's Linux runner can start Bun without setting TMPDIR. Establish it
// before the plugin preload and any test file allocate fixtures.
process.env.TMPDIR ??= tmpdir();
e2eTempRoot();

const guardImport = JSON.stringify(new URL("./root-environment.ts", import.meta.url).href);
Bun.plugin({
    name: "e2e-root-environment",
    setup(build) {
        // A preload-level afterAll runs once, after every test file has run.
        // Register a file-local hook after the file's own cleanup hooks instead.
        build.onLoad({ filter: /\.test\.ts$/ }, ({ path }) => {
            const before = JSON.stringify(snapshotRootEnvironment());
            return {
                contents: `${readFileSync(path, "utf8")}
import { afterAll as __e2eAfterFile } from "bun:test";
import { checkRootEnvironment as __e2eCheckRootEnvironment } from ${guardImport};
__e2eAfterFile(() => __e2eCheckRootEnvironment(${JSON.stringify(path)}, ${before}));
`,
                loader: "ts",
            };
        });
    },
});
