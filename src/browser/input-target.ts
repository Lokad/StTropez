import type { TextEdit } from "../core/changes.ts";

type NativeValue = Readonly<{ value: string; selectionStart: number; selectionEnd: number }>;
export type NativeInsertionTarget = Readonly<{ type: string; before: string; from: number; to: number; data: string | null }>;
/** Keep the actual native replacement range when repeated text makes a value diff ambiguous. */
export function captureNativeInsertion(input: NativeValue, type: string, data: string | null): NativeInsertionTarget | undefined {
    if (type !== "insertText" && type !== "insertLineBreak") return;
    return Object.freeze({ type, before: input.value, from: input.selectionStart, to: input.selectionEnd, data });
}
export function resolveNativeInsertion(target: NativeInsertionTarget, input: NativeValue, type: string): TextEdit | undefined {
    if (target.type !== type) return;
    const { before, from, to } = target, suffix = before.length - to, end = input.value.length - suffix;
    if (end < from || input.selectionStart !== end || input.selectionEnd !== end
        || input.value.slice(0, from) !== before.slice(0, from) || input.value.slice(end) !== before.slice(to)) return;
    const insert = input.value.slice(from, end);
    if (target.data !== null && target.data !== insert) return;
    return Object.freeze({ from, to, insert });
}
