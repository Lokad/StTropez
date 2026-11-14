import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Each run keeps its own record; only a passed run promotes its variant's latest report. */
export async function createReportWriter(directory, variant) {
    if (typeof variant !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(variant)) throw new TypeError("An explicit report variant is required.");
    const root = resolve(directory, variant), runId = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID();
    await mkdir(join(root, "runs"), { recursive: true });
    const file = join(root, "runs", runId + ".json"), latest = join(root, "latest.json");
    let terminal = false, pending = Promise.resolve();
    async function replace(path, text) {
        const temporary = path + "." + randomUUID() + ".tmp";
        try { await writeFile(temporary, text, { flag: "wx" }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
    }
    return Object.freeze({ file, latest, write(report) {
        if (!report || !["running", "passed", "failed"].includes(report.status) || report.variant !== undefined && report.variant !== variant)
            return Promise.reject(new TypeError("Expected a report status and matching variant."));
        const status = report.status, text = JSON.stringify({ ...report, variant, runId }, null, 2) + "\n";
        const result = pending.then(async () => {
            if (terminal) throw new Error("A completed report cannot be rewritten.");
            await replace(file, text);
            if (status === "passed") await replace(latest, text);
            terminal = status !== "running";
        });
        pending = result.catch(() => {}); return result;
    } });
}
