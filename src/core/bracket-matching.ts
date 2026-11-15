import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";
import { resolveLanguageConfiguration } from "./language-edits.ts";
import type { EditingPair, LanguageConfiguration, ResolvedLanguageConfiguration } from "./language-edits.ts";
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
    if (![maxWorkUnits, maxDepth].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("Invalid bracket limits.");
    return Object.freeze({ maxWorkUnits, maxDepth });
}

/** Local, syntax-neutral matching of asymmetric configured pairs. Compile once per language configuration. */
export class BracketMatcher {
    readonly configuration: ResolvedLanguageConfiguration;
    readonly #tokens = new Map<string, Roles>();
    constructor(configuration: LanguageConfiguration = {}) {
        this.configuration = resolveLanguageConfiguration(configuration);
        for (const pair of this.configuration.pairs) {
            // Symmetric quote pairs need lexical direction; they remain insertion/surrounding rules.
            if (pair.open === pair.close) continue;
            for (const char of [pair.open, pair.close]) if (!this.#tokens.has(char)) this.#tokens.set(char, { close: new Set() });
            this.#tokens.get(pair.open)!.open = pair; this.#tokens.get(pair.close)!.close.add(pair);
        }
        Object.freeze(this);
    }
    createCursor(buffer: TextBuffer, caret: number, options: BracketMatchOptions = {}): BracketMatchCursor {
        if (!Number.isSafeInteger(caret) || caret < 0 || caret > buffer.length) throw new RangeError("Invalid bracket caret.");
        const { maxWorkUnits: maxWork, maxDepth } = bracketMatchLimits(options);
        const tokens = this.#tokens, allow = this.configuration.allowPair;
        let work = 0, scanned = 0, reads = 0, calls = 0, at: number | null = null, direction: -1 | 1 | null = null;
        const exhausted = Symbol("bracket work limit");
        const result = (kind: BracketMatchResult["kind"], match: number | null = null, pair: EditingPair | null = null,
            limit: BracketMatchResult["limit"] = null): BracketMatchResult => Object.freeze({ kind, at, match, pair, direction, limit });
        function* tick(): Generator<void, void> { if (work === maxWork) throw exhausted; work++; if (work % 64 === 0) yield; }
        function* roles(char: string, offset: number): Generator<void, Roles> {
            const entry = tokens.get(char)!, found: Roles = { close: new Set() };
            for (const operation of ["open", "close"] as const) for (const pair of operation === "open" ? entry.open ? [entry.open] : [] : entry.close) {
                yield* tick();
                if (allow) { calls++; if (!allow(Object.freeze({ buffer, from: offset, to: offset + 1, pair, operation }))) continue; }
                if (operation === "open") found.open = pair; else found.close.add(pair);
            }
            return found;
        }
        function* scan(): Generator<void, BracketMatchResult | null> {
            try {
                if (!tokens.size) return result("none");
                let initial: Roles | undefined, vetoed = false;
                // Prefer the character at the caret, then the preceding character when absent or vetoed.
                for (const offset of [caret, caret - 1]) {
                    if (offset < 0 || offset >= buffer.length) continue;
                    yield* tick(); const char = buffer.slice(offset, offset + 1); reads++; scanned++;
                    if (!tokens.has(char)) continue;
                    const found = yield* roles(char, offset);
                    if (!found.open && !found.close.size) { vetoed = true; continue; }
                    at = offset; initial = found; break;
                }
                if (!initial) return result(vetoed ? "vetoed" : "none");
                if (initial.open && initial.close.size) return result("ambiguous");
                direction = initial.open ? 1 : -1;
                // Each backward frame may admit several openings that share a closing character.
                const pending: Roles[] = [initial];
                let offset = at! + direction;
                while (offset >= 0 && offset < buffer.length) {
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
                        const push = direction === 1 ? found.open : found.close.size;
                        const pop = direction === 1 ? found.close.size : found.open;
                        if (push) {
                            if (pending.length === maxDepth) return result("limited", null, null, "depth");
                            pending.push(found);
                        } else if (pop) {
                            const expected = pending[pending.length - 1]!, pair = direction === 1
                                ? found.close.has(expected.open!) ? expected.open : undefined
                                : expected.close.has(found.open!) ? found.open : undefined;
                            if (!pair) return result("unmatched");
                            pending.pop(); if (!pending.length) return result("matched", offset, pair);
                        }
                        offset += direction;
                    }
                }
                return result("unmatched");
            } catch (error) { if (error === exhausted) return result("limited", null, null, "work"); throw error; }
        }
        return kernelCursor(scan(), () => work, (status, result, failure): BracketMatchProgress => Object.freeze({
            status, result, failure, workUnits: work, scannedUnits: scanned, readUnits: reads, callbackCalls: calls }), "Bracket match");
    }
}
