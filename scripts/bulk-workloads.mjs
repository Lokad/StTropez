import { corpus, sourceLine } from "../fixtures/workloads.ts";
export const bulkWorkloadIds = ["dense-100", "dense-10000", "dense-100000", "sparse-line", "fragmented-point", "unicode", "large-inserts", "same-position"];
/** @param {string} id
 * @returns {{text: string, setup?: readonly import("../src/core/changes.ts").TextEdit[], edits: readonly import("../src/core/changes.ts").TextEdit[]}}
 */
export function bulkWorkload(id) {
    if (!bulkWorkloadIds.includes(id)) throw new Error("Unknown bulk workload.");
    if (id.startsWith("dense-")) {
        const lines = Number(id.slice(6)); return { text: sourceLine.repeat(lines), edits: Array.from({ length: lines }, (_, index) => ({ from: index * sourceLine.length, to: index * sourceLine.length + 5, insert: "let" })) };
    }
    if (id === "sparse-line") return { text: corpus("single-line"), edits: Array.from({ length: 10000 }, (_, index) => ({ from: index * 50, to: index * 50 + 1, insert: "y" })) };
    if (id === "fragmented-point") return { text: corpus("lines-100000"), setup: Array.from({ length: 512 }, (_, index) => ({ from: index * 100, to: index * 100, insert: "z" })),
        edits: [{ from: 1_200_256, to: 1_200_257, insert: "😀" }] };
    if (id === "unicode") {
        const text = corpus("unicode"); return { text, edits: [...text.matchAll(/\bconst\b/g)].map((match, index) => ({ from: match.index, to: match.index + 5, insert: index % 2 ? "let" : "é\r\n👩‍💻" })) };
    }
    if (id === "large-inserts") return { text: "x".repeat(70000) + "\r\n😀é\ud800", edits: [
        { from: 0, to: 0, insert: "\ud83d" }, { from: 0, to: 0, insert: "\ude00" }, { from: 1, to: 2, insert: "\n".repeat(65536) },
        { from: 2, to: 3, insert: "\r" + "Z".repeat(65537) }, { from: 60000, to: 60001, insert: "é".repeat(64) }] };
    // The modulo index stays within this fixed, nonempty sequence.
    if (id === "same-position") return { text: "ab", edits: Array.from({ length: 10000 }, (_, index) => ({ from: 0, to: 0, insert: /** @type {string} */ (["\ud83d", "\ude00", "\r", "\n", "é"][index % 5]) })) };
    throw new Error("Unknown bulk workload.");
}
