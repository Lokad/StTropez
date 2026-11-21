import { compactDocumentEdit } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { composePositionMapList } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type TextTransaction = Readonly<{ buffer: TextBuffer; edit: (edits: readonly TextEdit[]) => void }>;

/** Stage edits against successive immutable buffers. Workspace commits only the final result. */
export function stageTextTransaction(before: TextBuffer, action: (tx: TextTransaction) => void) {
    let buffer = before, changedUnits = 0, open = true, valid = true;
    const mappings: PositionMapping[] = [];
    const draft: TextTransaction = Object.freeze({
        get buffer() { return buffer; },
        edit(edits: readonly TextEdit[]) {
            if (!open || !valid) throw new Error("The text transaction is no longer open.");
            try {
                const result = buffer.apply(compactDocumentEdit(buffer, edits));
                if (result.buffer === buffer) return;
                buffer = result.buffer; mappings.push(result.mapping); changedUnits += result.changedUnits;
            } catch (error) { valid = false; throw error; }
        }
    });
    try {
        const returned: unknown = action(draft);
        if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
            // An unsupported asynchronous callback may try to use the closed draft after await.
            void Promise.resolve(returned).catch(() => {});
            throw new TypeError("A text transaction callback must be synchronous.");
        }
        if (!valid) throw new Error("A failed text transaction step cannot be committed.");
    } finally { open = false; }
    if (!mappings.length || mappings.length > 1 && buffer.equals(before)) return before.apply([]);
    return { buffer, changedUnits, mapping: composePositionMapList(mappings) };
}
