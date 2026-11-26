import { invalidRange, isNonNegativeInteger, isOffsetRange, isPositiveInteger } from "./bounds.ts";
import { defaultIgnorable } from "./default-ignorable.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { highSurrogate, lowSurrogate } from "./utf16.ts";

const labels = {
    "bidi-control": "Directional control",
    invisible: "Invisible character",
    bom: "Mid-file byte order mark",
    "non-breaking-space": "Non-breaking space",
    "unusual-space": "Unusual whitespace",
} as const;
export type CharacterWarningKind = keyof typeof labels;
export type CharacterWarningOptions = Readonly<{ categories?: Partial<Readonly<Record<CharacterWarningKind, boolean>>>; allow?: readonly string[] }>;
export type CharacterWarningConfiguration = Readonly<{ categories: Readonly<Record<CharacterWarningKind, boolean>>; allow: readonly string[] }>;
export type CharacterWarning = Readonly<{ from: number; to: number; codePoint: number; kind: CharacterWarningKind }>;
export type CharacterWarningLimits = Readonly<{ maxUnits?: number; maxWarnings?: number }>;
export type CharacterWarningBatch = Readonly<{ from: number; to: number; nextFrom: number; complete: boolean;
    limit: "units" | "warnings" | null; warnings: readonly CharacterWarning[]; scannedUnits: number; readUnits: number }>;
export function characterWarningLabel(warning: Pick<CharacterWarning, "kind" | "codePoint">): string {
    return `${labels[warning.kind]} (U+${warning.codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}
function bounds(length: number, from: number, to: number) {
    if (!isOffsetRange(from, to, length)) invalidRange("character-warning range");
}
function limits(options: CharacterWarningLimits) {
    const maxUnits = options.maxUnits ?? 4096, maxWarnings = options.maxWarnings ?? 256;
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 2 || !isPositiveInteger(maxWarnings)) invalidRange("character-warning limits");
    return { maxUnits, maxWarnings };
}

/** Advisory Unicode18 facts. Does not normalize text or infer whether a character is appropriate to its language. */
export class CharacterWarnings {
    readonly configuration: CharacterWarningConfiguration;
    readonly #allowed: ReadonlySet<number>;
    constructor(options: CharacterWarningOptions = {}) {
        const categories = {} as Record<CharacterWarningKind, boolean>;
        for (const kind of Object.keys(labels) as CharacterWarningKind[]) {
            categories[kind] = options.categories?.[kind] ?? true;
        }
        const allowed = new Set<number>();
        for (const character of options.allow ?? []) {
            if (!character.length || character.length !== (character.codePointAt(0)! > 0xffff ? 2 : 1)) throw new TypeError("Allow-list entries must be single characters.");
            allowed.add(character.codePointAt(0)!);
        }
        this.#allowed = allowed;
        this.configuration = Object.freeze({ categories: Object.freeze(categories), allow: Object.freeze([...allowed].map(value => String.fromCodePoint(value))) });
        Object.freeze(this);
    }
    kind(codePoint: number, offset = 0): CharacterWarningKind | null {
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || !isNonNegativeInteger(offset)) invalidRange("character-warning position");
        if (this.#allowed.has(codePoint) || codePoint < 128 && codePoint !== 11 && codePoint !== 12) return null;
        let kind: CharacterWarningKind | undefined;
        if (codePoint === 0xfeff) { if (offset === 0) return null; kind = "bom"; }
        else {
            if (codePoint === 0x061c || codePoint >= 0x200e && codePoint <= 0x200f
                || codePoint >= 0x202a && codePoint <= 0x202e || codePoint >= 0x2066 && codePoint <= 0x2069) kind = "bidi-control";
            else if (codePoint === 0x00a0 || codePoint === 0x2007 || codePoint === 0x202f) kind = "non-breaking-space";
            else if (codePoint === 11 || codePoint === 12 || codePoint === 0x85 || codePoint === 0x1680
                || codePoint >= 0x2000 && codePoint <= 0x200a || codePoint >= 0x2028 && codePoint <= 0x2029
                || codePoint === 0x205f || codePoint === 0x3000) kind = "unusual-space";
            else if (defaultIgnorable(codePoint)) kind = "invisible";
        }
        return kind && this.configuration.categories[kind] ? kind : null;
    }
    /** Returns complete code-point ranges intersecting [from,to), including a pair clipped at either edge.
     * Resume a limited batch at nextFrom against the same immutable buffer and original to. */
    scan(buffer: TextBuffer, from = 0, to = buffer.length, options: CharacterWarningLimits = {}): CharacterWarningBatch {
        bounds(buffer.length, from, to); const budget = limits(options);
        let start = from, end = to, reads = 0;
        const read = (from: number, to: number) => { reads += to - from; return buffer.slice(from, to); };
        if (from < to) {
            if (from > 0) { const pair = read(from - 1, Math.min(buffer.length, from + 1)); if (highSurrogate(pair.charCodeAt(0)) && lowSurrogate(pair.charCodeAt(1))) start--; }
            if (to < buffer.length) { const pair = read(Math.max(0, to - 1), to + 1); if (highSurrogate(pair.charCodeAt(0)) && lowSurrogate(pair.charCodeAt(1))) end++; }
        }
        const text = read(start, Math.min(end, start + budget.maxUnits + 1));
        return this.#scan(text, start, from, to, end, budget, reads);
    }
    /** Scan an already bounded, complete-code-point text fragment at its absolute document offset. */
    scanText(text: string, from = 0, options: CharacterWarningLimits = {}): CharacterWarningBatch {
        bounds(Number.MAX_SAFE_INTEGER, from, from + text.length); const budget = limits(options), to = from + text.length;
        const window = text.slice(0, budget.maxUnits + 1);
        return this.#scan(window, from, from, to, to, budget, window.length);
    }
    #scan(text: string, start: number, from: number, to: number, end: number, budget: Required<CharacterWarningLimits>, reads: number): CharacterWarningBatch {
        const warnings: CharacterWarning[] = []; let at = 0, limit: CharacterWarningBatch["limit"] = null;
        while (start + at < end) {
            if (at >= budget.maxUnits) { limit = "units"; break; }
            const codePoint = text.codePointAt(at)!, size = codePoint > 0xffff ? 2 : 1;
            if (at + size > budget.maxUnits) { limit = "units"; break; }
            const kind = this.kind(codePoint, start + at);
            if (kind) {
                if (warnings.length === budget.maxWarnings) { limit = "warnings"; break; }
                warnings.push(Object.freeze({ from: start + at, to: start + at + size, codePoint, kind }));
            }
            at += size;
        }
        const complete = start + at >= end;
        return Object.freeze({ from, to, nextFrom: complete ? to : start + at, complete, limit, warnings: Object.freeze(warnings), scannedUnits: at, readUnits: reads });
    }
}
