import { partitionPoint } from "./bound-search.ts";
import { isOffset, isPositiveInteger } from "./bounds.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";
import { resolveLanguageConfiguration } from "./language-configuration.ts";
import type { EditingPair, LanguageConfiguration, ResolvedLanguageConfiguration } from "./language-configuration.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type BracketMatchOptions = Readonly<{ maxWorkUnits?: number; maxDepth?: number }>;
export type BracketMatchResult = Readonly<{ kind: "none" | "vetoed" | "matched" | "unmatched" | "ambiguous" | "limited";
    at: number | null; match: number | null; pair: EditingPair | null; direction: -1 | 1 | null; limit: "work" | "depth" | null }>;
export type BracketMatchProgress = Readonly<{ status: KernelStatus; scannedUnits: number; readUnits: number; workUnits: number;
    callbackCalls: number; result: BracketMatchResult | null; failure: string | null }>;
export type BracketMatchCursor = KernelCursor<BracketMatchProgress>;
type Roles = { open?: EditingPair; close: Set<EditingPair> };

/** Shared validation for core cursors and browser configuration, before either mutates owned state. */
export function bracketMatchLimits(options: BracketMatchOptions = {}): Required<BracketMatchOptions> {
    const maxWorkUnits = options.maxWorkUnits ?? 100_000, maxDepth = options.maxDepth ?? 1024;
    if (![maxWorkUnits, maxDepth].every(isPositiveInteger)) throw new RangeError("Invalid bracket limits.");
    return Object.freeze({ maxWorkUnits, maxDepth });
}

/** Local, syntax-neutral matching of asymmetric configured pairs. */
export class BracketMatcher {
    readonly configuration: ResolvedLanguageConfiguration;
    constructor(configuration: LanguageConfiguration = {}) {
        this.configuration = resolveLanguageConfiguration(configuration);
        bracketTokens(this.configuration);
        Object.freeze(this);
    }
    createCursor(buffer: TextBuffer, caret: number, options: BracketMatchOptions = {}): BracketMatchCursor {
        return bracketCursor(this.configuration, buffer, caret, options);
    }
}

/** Match a closer at the insertion point without changing the host callback’s buffer. */
export function createClosingBracketCursor(configuration: ResolvedLanguageConfiguration, buffer: TextBuffer, at: number, closer: string): BracketMatchCursor {
    return bracketCursor(configuration, buffer, at, {}, { closer });
}
/** Jump to the partner, the enclosing closer, or the next eligible bracket. */
export function createBracketNavigationCursor(configuration: ResolvedLanguageConfiguration, buffer: TextBuffer, caret: number, options?: BracketMatchOptions) {
    return bracketCursor(configuration, buffer, caret, options ?? {}, "enclosing");
}
type Delimiter = {
    offset: number;
    roles: Roles;
    workBefore: number;
    workAfter: number;
    enclosing: Delimiter | null | undefined;
    depthBefore: number;
    partner?: Delimiter;
    pairDepth: number;
};

/** One command shares the nesting and work counts for its immutable document across carets. */
export function bracketNavigation(configuration: ResolvedLanguageConfiguration, buffer: TextBuffer,
    options: BracketMatchOptions | undefined, count: number, current?: () => boolean): (caret: number) => number | undefined {
    const { maxWorkUnits, maxDepth } = bracketMatchLimits(options);
    // Small bounded searches can examine less source than constructing the shared index.
    if (count === 1 || maxWorkUnits * count < buffer.length) {
        return caret => {
            const cursor = createBracketNavigationCursor(configuration, buffer, caret, options);
            try {
                const { result } = cursor.next(Number.MAX_SAFE_INTEGER);
                return result?.match ?? result?.next;
            } finally {
                cursor.dispose();
            }
        };
    }
    const roles = bracketTokens(configuration);
    if (!roles.size) return () => undefined;
    const allow = configuration.allowPair;
    const vetoed = new Map<number, number>();
    const pattern = new RegExp("[" + Array.from(roles.keys(),
        char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "]", "g");
    const delimiters: Delimiter[] = [];
    // Undefined reaches the start of the document. Null marks a crossed or ambiguous pair.
    let enclosing: Delimiter | null | undefined;
    // Peak depth of the backwards scan to the enclosing opener, or to the start.
    let depth = 0;
    let roleChecks = 0;
    let base = 0;
    for (const chunk of buffer.chunks()) {
        for (let hit = pattern.exec(chunk); hit; hit = pattern.exec(chunk)) {
            let entry = roles.get(hit[0])!;
            const offset = base + hit.index;
            const workBefore = offset + roleChecks;
            const probes = (entry.open ? 1 : 0) + entry.close.size;
            roleChecks += probes;
            if (allow) {
                const permitted = (pair: EditingPair, operation: "open" | "close") =>
                    allow(Object.freeze({ buffer, from: offset, to: offset + 1, pair, operation }));
                const open = entry.open && permitted(entry.open, "open") ? entry.open : undefined;
                const close = new Set<EditingPair>();
                for (const pair of entry.close) if (permitted(pair, "close")) close.add(pair);
                if (current && !current()) return () => undefined;
                if (!open && !close.size) {
                    vetoed.set(offset, probes);
                    continue;
                }
                entry = open ? { open, close } : { close };
            }
            const node: Delimiter = { offset, roles: entry, workBefore, workAfter: offset + 1 + roleChecks,
                enclosing, depthBefore: depth, pairDepth: 0 };
            delimiters.push(node);
            if (entry.open && !entry.close.size) {
                enclosing = node;
                depth = 0;
            } else if (entry.open) {
                enclosing = null;
            } else if (enclosing && entry.close.has(enclosing.roles.open!)) {
                node.partner = enclosing;
                enclosing.partner = node;
                node.pairDepth = enclosing.pairDepth = depth + 1;
                depth = Math.max(enclosing.depthBefore, node.pairDepth);
                enclosing = enclosing.enclosing;
            } else {
                if (enclosing) enclosing = null;
                depth++;
            }
        }
        base += chunk.length;
    }
    return caret => {
        const i = partitionPoint(delimiters.length, index => delimiters[index]!.offset < caret);
        const next = delimiters[i];
        const previous = delimiters[i - 1];
        const direct = next?.offset === caret ? next : previous?.offset === caret - 1 ? previous : undefined;
        const probes = (caret < buffer.length ? 1 + (vetoed.get(caret) ?? 0) : 0)
            + (caret > 0 && next?.offset !== caret ? 1 + (vetoed.get(caret - 1) ?? 0) : 0);
        const opening = next ? next.enclosing : enclosing;
        const node = direct ?? opening;
        if (node?.partner) {
            const mate = node.partner;
            const work = Math.max(node.workAfter, mate.workAfter) - Math.min(node.workBefore, mate.workBefore);
            // The initial probe already counted the character at an adjacent delimiter.
            if (node.pairDepth <= maxDepth && work + probes - (direct ? 1 : 0) <= maxWorkUnits) return mate.offset;
        } else if (!direct && opening === undefined && next && !(next.roles.open && next.roles.close.size)) {
            // With no enclosing pair the cursor scans to the start, then to the next delimiter.
            if (next.depthBefore < maxDepth && next.workAfter + probes <= maxWorkUnits) return next.offset;
        }
        return undefined;
    };
}
const compiled = new WeakMap<ResolvedLanguageConfiguration, Map<string, Roles>>();
function bracketTokens(configuration: ResolvedLanguageConfiguration) {
    let tokens = compiled.get(configuration);
    if (!tokens) {
        tokens = new Map();
        for (const pair of configuration.pairs) {
            // Symmetric quote pairs need lexical direction; they remain insertion/surrounding rules.
            if (pair.open === pair.close) continue;
            for (const char of [pair.open, pair.close]) if (!tokens.has(char)) tokens.set(char, { close: new Set() });
            tokens.get(pair.open)!.open = pair; tokens.get(pair.close)!.close.add(pair);
        }
        compiled.set(configuration, tokens);
    }
    return tokens;
}
function bracketCursor(configuration: ResolvedLanguageConfiguration, buffer: TextBuffer, caret: number,
    options: BracketMatchOptions, mode?: "enclosing" | { closer: string }) {
    const typedCloser = typeof mode === "object" ? mode.closer : undefined;
    const tokens = bracketTokens(configuration);
    if (!isOffset(caret, buffer.length)) throw new RangeError("Invalid bracket caret.");
    const { maxWorkUnits: maxWork, maxDepth } = bracketMatchLimits(options);
    const allow = configuration.allowPair;
    let work = 0, scanned = 0, reads = 0, calls = 0, at: number | null = null, direction: -1 | 1 | null = null;
    const exhausted = Symbol("bracket work limit");
    const result = (kind: BracketMatchResult["kind"], match: number | null = null, pair: EditingPair | null = null,
        limit: BracketMatchResult["limit"] = null): BracketMatchResult => Object.freeze({ kind, at, match, pair, direction, limit });
    function* tick(): Generator<void, void> { if (work === maxWork) throw exhausted; work++; if (work % 64 === 0) yield; }
    function* roles(char: string, offset: number, to = offset + 1): Generator<void, Roles> {
        const entry = tokens.get(char)!, found: Roles = { close: new Set() };
        for (const operation of ["open", "close"] as const) for (const pair of operation === "open" ? entry.open ? [entry.open] : [] : entry.close) {
            yield* tick();
            if (allow) { calls++; if (!allow(Object.freeze({ buffer, from: offset, to, pair, operation }))) continue; }
            if (operation === "open") found.open = pair; else found.close.add(pair);
        }
        return found;
    }
    function* scan(): Generator<void, (BracketMatchResult & { readonly next?: number }) | null> {
        try {
            if (!tokens.size) return result("none");
            let initial: Roles | undefined, vetoed = false;
            // Prefer the character at the caret, then the preceding character when absent or vetoed.
            for (const offset of typedCloser === undefined ? [caret, caret - 1] : [caret]) {
                if (typedCloser === undefined && (offset < 0 || offset >= buffer.length)) continue;
                yield* tick(); const char = typedCloser ?? buffer.slice(offset, offset + 1);
                if (typedCloser === undefined) { reads++; scanned++; }
                if (!tokens.has(char)) continue;
                const found = yield* roles(char, offset, typedCloser === undefined ? offset + 1 : offset);
                if (!found.open && !found.close.size) { vetoed = true; continue; }
                at = offset; initial = found; break;
            }
            if (!initial && mode !== "enclosing") return result(vetoed ? "vetoed" : "none");
            if (initial?.open && initial.close.size) return result("ambiguous");
            direction = initial?.open ? 1 : -1;
            // Each backward frame may admit several openings that share a closing character.
            const pending: Roles[] = initial ? [initial] : [];
            let offset = at === null ? caret - 1 : at + direction;
            while (offset < buffer.length) {
                if (offset < 0) {
                    if (at !== null) break;
                    // Reaching the start with no enclosing opener leaves only the forward search.
                    direction = 1;
                    offset = caret;
                    continue;
                }
                const from = direction === 1 ? offset : Math.max(0, offset - 255);
                const to = direction === 1 ? Math.min(buffer.length, offset + 256) : offset + 1;
                const text = buffer.slice(from, to); reads += text.length;
                while (offset >= from && offset < to) {
                    if (work === maxWork) throw exhausted; work++; if (work % 64 === 0) yield;
                    scanned++;
                    const char = text[offset - from]!;
                    if (!tokens.has(char)) { offset += direction; continue; }
                    const found = yield* roles(char, offset);
                    if (found.open && found.close.size) return result("ambiguous");
                    if (at === null && direction === 1 && (found.open || found.close.size)) {
                        return Object.freeze({ ...result("none"), next: offset });
                    }
                    const push = direction === 1 ? found.open : found.close.size;
                    const pop = direction === 1 ? found.close.size : found.open;
                    if (push) {
                        if (pending.length + (at === null ? 1 : 0) >= maxDepth) return result("limited", null, null, "depth");
                        pending.push(found);
                    } else if (pop) {
                        // Balanced pairs left of the caret have already been checked. Resume
                        // at the caret to match the first opener that still encloses it.
                        if (!pending.length) {
                            at = offset; pending.push(found); direction = 1; offset = caret; break;
                        }
                        const expected = pending[pending.length - 1]!, pair = direction === 1
                            ? found.close.has(expected.open!) ? expected.open : undefined
                            : expected.close.has(found.open!) ? found.open : undefined;
                        if (!pair) return result("unmatched");
                        pending.pop(); if (!pending.length && at !== null) return result("matched", offset, pair);
                    }
                    offset += direction;
                }
            }
            return result(at === null ? "none" : "unmatched");
        } catch (error) { if (error === exhausted) return result("limited", null, null, "work"); throw error; }
    }
    return kernelCursor(scan(), () => work, (status, result, failure) => Object.freeze({
        status, result, failure, workUnits: work, scannedUnits: scanned, readUnits: reads, callbackCalls: calls }), "Bracket match");
}
