import { pathToFileURL } from "node:url";

/** Run inside extension initialization, before the host can send a model request. */
export default async function workerReviewExtension(): Promise<void> {
    const driver = process.env.MC_REVIEW_DRIVER;
    if (!driver) throw new Error("worker review driver is required");
    const args = JSON.parse(process.env.MC_REVIEW_ARGUMENTS ?? "[]") as string[];
    process.argv = [process.execPath, driver, ...args];
    try {
        await import(pathToFileURL(driver).href);
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
