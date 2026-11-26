import type { SaveResponse, SaveSubmission } from "sttropez";

export type SavedCopy = Readonly<{ version: string; text: string }>;
export type StorageMode = Readonly<{
    delay: boolean;
    canonical: boolean;
    compareVersions: boolean;
    fault: "none" | "fail" | "lose-reply";
}>;

/** Browser storage belongs to the reference host. All its tabs use the same write lock. */
export function referenceStorage(initial: string) {
    const key = "sttropez.reference.quote.v1";
    function read(): SavedCopy {
        const raw = localStorage.getItem(key);
        if (raw === null) return { version: "initial", text: initial };
        const copy: unknown = JSON.parse(raw);
        if (!copy || typeof copy !== "object" || !("version" in copy) || typeof copy.version !== "string"
            || !("text" in copy) || typeof copy.text !== "string") throw new Error("Cannot read the saved quote.");
        return { version: copy.version, text: copy.text };
    }
    async function write(submission: SaveSubmission, mode: StorageMode): Promise<SaveResponse> {
        if (mode.delay) await new Promise(resolve => setTimeout(resolve, 500));
        if (mode.fault === "fail") throw new Error("The write failed. Your edits are still here.");
        const text = mode.canonical ? submission.value.trimEnd() + "\n" : submission.value;
        function commit(): SaveResponse {
            const latest = read();
            if (latest.text === text) return { kind: "saved", serverVersion: latest.version, canonical: text };
            if (mode.compareVersions && latest.version !== submission.expectedServerVersion) {
                return { kind: "conflict", serverVersion: latest.version };
            }
            const version = crypto.randomUUID();
            localStorage.setItem(key, JSON.stringify({ version, text }));
            if (mode.fault === "lose-reply") throw new Error("The save reply was lost. Retry to check the saved copy.");
            return { kind: "saved", serverVersion: version, canonical: text };
        }
        return mode.compareVersions ? navigator.locks.request(key, commit) : commit();
    }
    return { read, write };
}
