import { invalidRange } from "../core/bounds.ts";
import { PositionMap, composePositionMaps } from "../core/positions.ts";
import { importText } from "../core/newlines.ts";
import type { Affinity } from "../core/positions.ts";
import type { Selection } from "../core/history.ts";
import type { TextBuffer } from "../core/text-buffer.ts";

export type InputContext = Readonly<{ text: string; from: number; to: number; nativeAnchor: number; nativeHead: number;
    toModel: (offset: number, affinity?: Affinity) => number; toNative: (offset: number, affinity?: Affinity) => number }>;
const defaultContextUnits = 256, defaultSelectedUnits = 2048;
export const inputContextUnits = defaultContextUnits * 2 + defaultSelectedUnits;
/** A large selection is represented by one selected placeholder, never by exporting its contents. */
export function inputContext(buffer: TextBuffer, selection: Selection, contextUnits = defaultContextUnits, selectedUnits = defaultSelectedUnits): InputContext {
    const low = Math.min(selection.anchor, selection.head), high = Math.max(selection.anchor, selection.head);
    if (![low, high, contextUnits, selectedUnits].every(Number.isSafeInteger) || low < 0 || high > buffer.length || contextUnits < 0 || selectedUnits < 0) invalidRange("input context");
    const from = Math.max(0, low - contextUnits), to = Math.min(buffer.length, high + contextUnits), compressed = high - low > selectedUnits;
    const virtual = compressed ? buffer.slice(from, low) + "\ufffc" + buffer.slice(high, to) : buffer.slice(from, to);
    const collapsed = new PositionMap(to - from, compressed ? [{ from: low - from, to: high - from, insert: "\ufffc" }] : []);
    const imported = importText(virtual, "lf"), mapping = composePositionMaps(collapsed, imported.mapping), inverse = mapping.invert();
    const toModel = (offset: number, affinity: Affinity = "before") => from + inverse.map(offset, affinity).offset;
    const toNative = (offset: number, affinity: Affinity = "before") => mapping.map(offset - from, affinity).offset;
    return Object.freeze({ text: imported.text, from, to, nativeAnchor: toNative(selection.anchor), nativeHead: toNative(selection.head), toModel, toNative });
}
