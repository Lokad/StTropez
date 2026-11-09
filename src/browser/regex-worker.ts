import { RegexSession } from "./regex-session.ts";
import type { RegexReply } from "./regex-session.ts";
const session = new RegexSession();
let continuation: { id: number; revision: number; replies: Generator<RegexReply> } | undefined;
function publish(replies: Generator<RegexReply>): void {
    try {
        for (let result = replies.next(); !result.done; result = replies.next()) {
            globalThis.postMessage(JSON.stringify(result.value));
            if (["regex-matches", "regex-edits", "regex-edit", "regex-insert"].includes(result.value.operation)) {
                continuation = { id: result.value.id, revision: result.value.revision, replies }; return;
            }
        }
    } catch { globalThis.postMessage(JSON.stringify({ operation: "regex-worker-error", message: "Regex search failed; editing remains available." })); }
}
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
    let decoded: unknown;
    try { if (typeof event.data !== "string" || event.data.length > 262144) throw new TypeError(); decoded = JSON.parse(event.data); }
    catch { decoded = null; }
    if (typeof decoded === "object" && decoded !== null && "operation" in decoded && decoded.operation === "regex-continue") {
        if (continuation && "id" in decoded && decoded.id === continuation.id && "revision" in decoded && decoded.revision === continuation.revision) {
            const current = continuation; continuation = undefined; publish(current.replies);
        }
        return;
    }
    if (continuation && typeof decoded === "object" && decoded !== null && "id" in decoded && "revision" in decoded
        && (decoded.id !== continuation.id || decoded.revision !== continuation.revision)) return;
    continuation?.replies.return(undefined); continuation = undefined;
    // Acknowledgement bounds result queues as well as source transfer. A native match
    // itself may not yield; the owner terminates this lane on timeout or changed intent.
    publish(session.receive(decoded));
});
