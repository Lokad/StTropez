import { invalidRange, isPositiveInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";

export type EditingPair = Readonly<{ open: string; close: string }>;
export type LanguageEditContext = Readonly<{ buffer: TextBuffer; from: number; to: number }>;
export type PairingContext = LanguageEditContext & Readonly<{ pair: EditingPair; operation: "open" | "close" | "surround" }>;
export type EnterIndent = Readonly<{ indent: -1 | 0 | 1; split?: boolean }>;
/** Callbacks inspect this exact immutable buffer; language analysis and its cost belong to the host. */
export type LanguageConfiguration = Readonly<{
    tabSize?: number; insertSpaces?: boolean;
    lineComment?: string; blockComment?: EditingPair;
    pairs?: readonly EditingPair[];
    allowPair?: (context: PairingContext) => boolean;
    enter?: "keep" | ((context: LanguageEditContext) => EnterIndent);
}>;
export type ResolvedLanguageConfiguration = LanguageConfiguration & Readonly<{ tabSize: number; insertSpaces: boolean; pairs: readonly EditingPair[] }>;
const defaultPairs: readonly EditingPair[] = [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: "{", close: "}" }];

export function resolveLanguageConfiguration(value: LanguageConfiguration = {}): ResolvedLanguageConfiguration {
    const tabSize = value.tabSize ?? 4;
    if (!isPositiveInteger(tabSize) || tabSize > 256) throw new RangeError("tabSize must be an integer from 1 to 256.");
    const pair = (value: EditingPair, single: boolean): EditingPair => {
        if (!value.open || !value.close || /[\r\n]/.test(value.open + value.close) || single && (value.open.length !== 1 || value.close.length !== 1)) invalidRange("editing delimiter");
        return Object.freeze({ open: value.open, close: value.close });
    };
    if (value.lineComment !== undefined && (!value.lineComment || /[\r\n]/.test(value.lineComment))) invalidRange("line comment delimiter");
    const pairs = Object.freeze((value.pairs ?? defaultPairs).map(value => pair(value, true)));
    if (new Set(pairs.map(pair => pair.open)).size !== pairs.length) throw new RangeError("Duplicate opening delimiter.");
    return Object.freeze({ ...value, tabSize, insertSpaces: value.insertSpaces ?? true, pairs,
        ...(value.blockComment ? { blockComment: pair(value.blockComment, false) } : {}) });
}
