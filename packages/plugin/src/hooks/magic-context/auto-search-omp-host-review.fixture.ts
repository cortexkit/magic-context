import { pathToFileURL } from "node:url";

/** OMP guards awaited factories against process.exit. Return from initialization
 * before running the no-prompt driver; its workers must close their own handles. */
export default function ompWorkerReviewExtension(): void {
    const driver = process.env.MC_REVIEW_DRIVER;
    if (!driver) throw new Error("worker review driver is required");
    const args = JSON.parse(process.env.MC_REVIEW_ARGUMENTS ?? "[]") as string[];
    console.log("actual OMP extension factory invoked");
    setTimeout(() => {
        process.argv = [process.execPath, driver, ...args];
        void import(pathToFileURL(driver).href).then(
            () => process.exit(0),
            (error) => {
                console.error(error);
                process.exit(1);
            },
        );
    }, 100);
}
