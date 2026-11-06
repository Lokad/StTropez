import { PositionMap, composePositionMaps, importText } from "../index.ts";
import type { Affinity, Selection, TextBuffer } from "../index.ts";

export type InputContext = Readonly<{ text: string; from: number; to: number; nativeAnchor: number; nativeHead: number;
    toModel: (offset: number, affinity?: Affinity) => number; toNative: (offset: number, affinity?: Affinity) => number }>;
/** A large selection is represented by one selected placeholder, never by exporting its contents. */
export function inputContext(buffer: TextBuffer, selection: Selection, contextUnits = 256, selectedUnits = 2048): InputContext {
    const low = Math.min(selection.anchor, selection.head), high = Math.max(selection.anchor, selection.head);
    if (![low, high, contextUnits, selectedUnits].every(Number.isSafeInteger) || low < 0 || high > buffer.length || contextUnits < 0 || selectedUnits < 0) throw new RangeError("Invalid input context.");
    const from = Math.max(0, low - contextUnits), to = Math.min(buffer.length, high + contextUnits), compressed = high - low > selectedUnits;
    const virtual = compressed ? buffer.slice(from, low) + "\ufffc" + buffer.slice(high, to) : buffer.slice(from, to);
    const collapsed = new PositionMap(to - from, compressed ? [{ from: low - from, to: high - from, insert: "\ufffc" }] : []);
    const imported = importText(virtual, "lf"), mapping = composePositionMaps(collapsed, imported.mapping), inverse = mapping.invert();
    const toModel = (offset: number, affinity: Affinity = "before") => from + inverse.map(offset, affinity).offset;
    const toNative = (offset: number, affinity: Affinity = "before") => mapping.map(offset - from, affinity).offset;
    return Object.freeze({ text: imported.text, from, to, nativeAnchor: toNative(selection.anchor), nativeHead: toNative(selection.head), toModel, toNative });
}
