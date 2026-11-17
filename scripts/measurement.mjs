import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, cpus, freemem, totalmem, platform, release, loadavg } from "node:os";

/**
 * @param {readonly number[]} samples
 * @returns {{samples: readonly number[], n: number, max: number, p50: number, p95: number, statistic: "max" | "p95"}}
 */
export function distribution(samples) {
    const sorted = [...samples];
    // Validate the captured values; iteration materializes missing array elements.
    if (!sorted.length || sorted.some(sample => !Number.isFinite(sample) || sample < 0)) throw new Error("Missing or invalid timing samples.");
    sorted.sort((a, b) => a - b);
    /** @param {0.5 | 0.95 | 1} fraction */
    const percentile = fraction => {
        // These nearest ranks are within the validated, non-empty array.
        return /** @type {number} */ (sorted[Math.ceil(sorted.length * fraction) - 1]);
    };
    return { samples, n: sorted.length, max: percentile(1), p50: percentile(.5), p95: percentile(.95),
        statistic: sorted.length < 20 ? "max" : "p95" };
}

/**
 * Small batches describe their observed maximum, not an inferred latency tail.
 * @param {Pick<ReturnType<typeof distribution>, "n" | "p50" | "p95" | "max">} value
 */
export function timingSummary({ n, p50, p95, max }) { return { n, p50, max, ...(n >= 20 ? { p95 } : {}) }; }

export async function sourceIdentity() {
    if (process.env.STTROPEZ_SOURCE_MANIFEST) {
        const manifest = JSON.parse(await readFile(process.env.STTROPEZ_SOURCE_MANIFEST, "utf8"));
        const hash = createHash("sha256");
        for (const file of manifest.files) {
            if (file.path.startsWith("/") || file.path.includes("..") || file.path.includes(":")) throw new Error("Invalid source manifest path.");
            const sha256 = createHash("sha256").update(await readFile(file.path)).digest("hex");
            if (sha256 !== file.sha256) throw new Error(`Campaign source mismatch: ${file.path}`);
            hash.update(file.path).update("\0").update(sha256).update("\0");
        }
        if (hash.digest("hex") !== manifest.sha256) throw new Error("Campaign source manifest mismatch.");
        return manifest;
    }
    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
    const hash = createHash("sha256");
    const files = [];
    for (const path of paths) {
        const bytes = await readFile(path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        hash.update(path).update("\0").update(sha256).update("\0");
        files.push({ path, sha256 });
    }
    let commit = null;
    try { commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* New repository. */ }
    return { commit, sha256: hash.digest("hex"), files };
}

export function environment() {
    return { node: process.version, platform: platform(), release: release(), arch: arch(),
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem(), availableMemory: freemem(),
        loadAverage: platform() === "win32" ? null : loadavg() };
}
