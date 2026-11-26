import { basePattern, extendPattern } from "./word-patterns.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { lineContentEnd } from "./newlines.ts";
import { readUtf16Window } from "./utf16.ts";

type Bounds = Readonly<{ from: number; to: number }>;
type Kind = "word" | "space" | "symbol" | "extend";
type Unit = Readonly<{ from: number; to: number; kind: Kind; control: boolean }>;
const extendExpression = new RegExp(`^${extendPattern}$`, "u"), baseExpression = new RegExp(`^${basePattern}$`, "u");
export const isCodeWordBase = (text: string): boolean => baseExpression.test(text);
const kind = (text: string): Kind => extendExpression.test(text) ? "extend" : /^\p{White_Space}$/u.test(text) ? "space" : isCodeWordBase(text) ? "word" : "symbol";
/** Search boundaries use the same code-word constituents, including attached marks/joiners. */
export const wordConstituent = (text: string): boolean => { const value = kind(text); return value === "word" || value === "extend"; };
const symbolPattern = "[^\\p{M}\\u200c\\u200d\\p{White_Space}\\p{L}\\p{N}\\p{Pc}]";
// A base and its attached marks have one class. Leading marks stay separate so the
// directional scan can attach them across windows and preserve whitespace/control rules.
const runExpression = new RegExp(`(${extendPattern}+)|(\\p{White_Space}+)|(${basePattern}(?:${basePattern}|${extendPattern})*)|(${symbolPattern}(?:${symbolPattern}|${extendPattern})*)`, "gu");
const spaceControl = (code: number): boolean => code >= 9 && code <= 13 || code === 0x85 || code === 0x2028 || code === 0x2029;
function* units(buffer: TextBuffer, start: number, direction: -1 | 1, bounds: Bounds): Generator<Unit> {
    let offset = start;
    while (direction < 0 ? offset > bounds.from : offset < bounds.to) {
        const { from, to, text } = readUtf16Window(buffer, offset, direction < 0 ? bounds.from : bounds.to, direction);
        // Reverse traversal retains one window, including a surrogate pair that straddles its edge.
        const runs = text.matchAll(runExpression);
        for (const run of direction > 0 ? runs : [...runs].reverse()) {
            const type: Kind = run[1] ? "extend" : run[2] ? "space" : run[3] ? "word" : "symbol";
            const end = run.index + run[0].length;
            yield { from: from + run.index, to: from + end, kind: type, control: type === "space" && spaceControl(text.charCodeAt(end - 1)) };
        }
        offset = direction < 0 ? from : to;
    }
}
function scan(buffer: TextBuffer, start: number, direction: -1 | 1, bounds: Bounds): number {
    let current: Exclude<Kind, "extend"> | undefined, pending: number | undefined, afterControl = false;
    for (const unit of units(buffer, start, direction, bounds)) {
        if (direction > 0) {
            const next = unit.kind === "extend" ? afterControl ? "symbol" : current ?? "symbol" : unit.kind;
            if (current !== undefined && next !== current) return unit.from;
            current = next;
            afterControl = unit.control;
        } else {
            // Marks/join controls belong to their preceding base, which arrives later in reverse.
            if (unit.kind === "extend") { pending ??= unit.to; continue; }
            if (pending !== undefined && unit.control) return current === undefined || current === "symbol" ? unit.to : pending;
            if (current !== undefined && unit.kind !== current) return pending ?? unit.to;
            current = unit.kind;
            pending = undefined;
        }
    }
    return direction < 0 ? pending !== undefined && current === "word" ? pending : bounds.from : bounds.to;
}

export function wordCommandOffset(buffer: TextBuffer, offset: number, direction: -1 | 1, deleting: boolean,
    caretCount: number): number {
    let line = buffer.lineAt(offset), from = buffer.offsetAt(line), to = lineContentEnd(buffer, line);
    let start = Math.min(offset, to);
    const crossing = direction > 0 ? start === to : start === from;
    if (crossing) {
        line += direction;
        if (line < 0 || line >= buffer.lineCount) return start;
        from = buffer.offsetAt(line); to = lineContentEnd(buffer, line); start = direction < 0 ? to : from;
        if (deleting && direction < 0) return to;
    }
    const adjacentKind = (at: number, side = direction): Kind | undefined => {
        if (at === (side < 0 ? from : to)) return;
        const text = side < 0 ? buffer.slice(Math.max(from, at - 2), at) : buffer.slice(at, Math.min(to, at + 2));
        return kind(side < 0 ? Array.from(text).at(-1)! : String.fromCodePoint(text.codePointAt(0)!));
    };
    const run = (at: number) => scan(buffer, at, direction, { from, to });
    let type = adjacentKind(start);
    if (type === "space") {
        const end = run(start);
        if (deleting && (crossing || Math.abs(start - end) >= 2)) return end;
        start = end; type = adjacentKind(start);
    }
    if (!type || deleting && crossing) return start;
    const end = run(start);
    const skipSeparator = !deleting && (direction > 0 || caretCount === 1);
    if (skipSeparator && type === "symbol" && Math.abs(end - start) === 1 && adjacentKind(end) === "word") {
        const reverse = direction < 0 ? 1 : -1;
        let neighbor = adjacentKind(start, reverse);
        // A preceding mark belongs to its base, which can lie outside the two-unit window.
        if (neighbor === "extend" && reverse < 0) {
            for (const unit of units(buffer, start, reverse, { from, to })) {
                neighbor = unit.kind;
                if (neighbor !== "extend") break;
            }
        }
        if (neighbor === "symbol" || neighbor === "extend") return end;
        return run(end);
    }
    return end;
}

/** Find a lexical boundary in the captured UTF-16 interval. */
export function wordBoundary(buffer: TextBuffer, offset: number, direction: -1 | 1, bounds: Bounds): number {
    const { from, to } = bounds;
    if (![offset, from, to].every(Number.isSafeInteger) || from < 0 || from > offset || offset > to || to > buffer.length) {
        throw new RangeError("Invalid word command target.");
    }
    return scan(buffer, offset, direction, bounds);
}
