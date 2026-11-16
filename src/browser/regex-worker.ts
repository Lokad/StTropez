import { RegexSession } from "../protocol/regex-session.ts";
import { decodeRegexMessage, regexIdentity } from "../protocol/regex.ts";
import type { RegexReply } from "../protocol/regex.ts";
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
    } catch (error) {
        continuation = undefined; replies.return(undefined);
        const reply = session.abort();
        if (!reply) throw error; // No live capture: the worker error channel settles the client.
        globalThis.postMessage(JSON.stringify(reply));
    }
}
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
    const decoded = decodeRegexMessage(event.data);
    if (decoded?.operation === "regex-continue") {
        if (continuation && regexIdentity(decoded) && decoded.id === continuation.id && decoded.revision === continuation.revision) {
            const current = continuation; continuation = undefined; publish(current.replies);
        }
        return;
    }
    if (continuation && decoded && "id" in decoded && "revision" in decoded
        && (decoded.id !== continuation.id || decoded.revision !== continuation.revision)) return;
    continuation?.replies.return(undefined); continuation = undefined;
    // Acknowledgement bounds result queues as well as source transfer. A native match
    // itself may not yield; the owner terminates this lane on timeout or changed intent.
    publish(session.receive(decoded));
});
