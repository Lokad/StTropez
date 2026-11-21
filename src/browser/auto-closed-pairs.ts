import type { TextEdit } from "../core/changes.ts";
import type { EditingPair } from "../core/language-edits.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";

// Keys are closer offsets, values are their openers. A mounted view owns its pair history.
export function autoClosedPairs() {
    const empty: ReadonlyMap<number, number> = new Map();
    let history = new WeakMap<TextBuffer, ReadonlyMap<number, number>>();
    let revision = -1, pairs = empty;
    function save(buffer: TextBuffer, next: ReadonlyMap<number, number>): void {
        pairs = next.size ? next : empty;
        if (pairs.size) history.set(buffer, pairs); else history.delete(buffer);
    }
    function sync(document: DocumentSnapshot): void {
        if (document.revision === revision) return;
        const change = document.change, previous = revision;
        revision = document.revision;
        if (change?.kind === "undo" || change?.kind === "redo") { pairs = history.get(document.buffer) ?? empty; return; }
        if (!pairs.size || change?.previousRevision !== previous) { pairs = empty; return; }
        const next = new Map<number, number>();
        const map = (at: number) => change.mapping.mapRange({ from: at, to: at + 1, fromAffinity: "after", toAffinity: "before", onDelete: "invalidate" });
        for (const [close, open] of pairs) {
            const left = map(open), right = map(close);
            if (left && right) next.set(right.from, left.from);
        }
        save(document.buffer, next);
    }
    return {
        sync,
        has: (at: number) => pairs.has(at),
        emptyAt: (at: number) => pairs.get(at) === at - 1,
        clear() { revision = -1; pairs = empty; history = new WeakMap(); },
        accept(document: DocumentSnapshot, before: number, edits: readonly TextEdit[], selections: SelectionSet,
            pair: EditingPair | undefined, overtyped: readonly number[]): void {
            sync(document);
            const change = document.revision === before ? null : document.change;
            if (document.revision !== before && change?.previousRevision !== before) return;
            if (!overtyped.length && (!pair || !edits.length)) return;
            const next = new Map(pairs);
            for (const at of overtyped) next.delete(change ? change.mapping.map(at, "after").offset : at);
            if (pair && edits.length) {
                // Use the edits that actually committed, including any host transformation.
                const surrounds = new Map<number, number>();
                for (const { anchor, head } of selections.ranges) if (anchor !== head) surrounds.set(Math.min(anchor, head), Math.max(anchor, head));
                let delta = 0, open = -1, until = -1;
                for (const edit of edits) {
                    const at = edit.from + delta;
                    if (edit.from === edit.to) {
                        if (edit.insert === pair.open + pair.close) next.set(at + 1, at);
                        else if (edit.from === until && edit.insert === pair.close) { next.set(at, open); until = -1; }
                        else if (edit.insert === pair.open && surrounds.has(edit.from)) { open = at; until = surrounds.get(edit.from)!; }
                    }
                    delta += edit.insert.length - (edit.to - edit.from);
                }
            }
            save(document.buffer, next);
        },
    };
}
