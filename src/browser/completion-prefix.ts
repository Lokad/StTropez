import type { TextBuffer } from "../core/text-buffer.ts";
import { codeWordConstituentPattern } from "../core/word-patterns.ts";
import type { LspCompletion, LspCompletionFallback } from "../protocol/index.ts";

const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");
// A word prefix can end in digits. A run of decimal digits on its own has no name to complete.
const namedPrefix = new RegExp(`(?:\\$|(?!\\p{Nd})${codeWordConstituentPattern})\\p{Nd}*$`, "u");
export const hasNamedPrefix = (buffer: TextBuffer, head: number) => namedPrefix.test(buffer.slice(Math.max(0, head - 2048), head));

export function isCompletionWord(text: string): boolean {
    for (const point of text) {
        if (!word.test(point)) return false;
    }
    return true;
}

export function completionWordRange(buffer: TextBuffer, offset: number): LspCompletionFallback {
    const from = Math.max(0, offset - 2048);
    const to = Math.min(buffer.length, offset + 2048);
    const text = buffer.slice(from, to);
    const at = offset - from;
    let low = at;
    let high = at;
    for (const point of Array.from(text.slice(0, at)).reverse()) {
        if (!word.test(point)) break;
        low -= point.length;
    }
    for (const point of text.slice(at)) {
        if (!word.test(point)) break;
        high += point.length;
    }
    if (low === 0 && from > 0 || high === text.length && to < buffer.length) {
        throw new RangeError("Completion word extends beyond the bounded window.");
    }
    return { from: from + low, to: offset, replaceTo: from + high };
}

/** Providers can include punctuation in their edit range. Read each distinct prefix once. */
export function filterCompletions(items: readonly LspCompletion[], buffer: TextBuffer, caret: number,
    prefix: boolean, selected: LspCompletion | undefined) {
    const prefixes = new Map<number, string>();
    const visible = prefix ? items.filter(item => {
        const from = item.primary.from;
        let content = prefixes.get(from);
        if (content === undefined) {
            content = caret >= from && caret - from <= 2048 ? buffer.slice(from, caret).toLowerCase() : "";
            prefixes.set(from, content);
        }
        return !content || item.filterText.toLowerCase().startsWith(content);
    }) : items;
    const index = selected ? visible.indexOf(selected) : -1;
    const choice = index >= 0 ? index : Math.max(0, visible.findIndex(item => item.preselect));
    return { visible, choice };
}
