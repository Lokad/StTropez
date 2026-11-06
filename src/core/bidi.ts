import { BidiCursor } from "./bidi-cursor.ts";

export type BidiDirection = "ltr" | "rtl" | "auto";
export type BidiParagraph = Readonly<{ from: number; to: number; level: number }>;
/** Levels use UTF-16 offsets; null removes a formatting character under X9. Order lists code-point starts. */
export type BidiText = Readonly<{ levels: readonly (number | null)[]; order: readonly number[]; paragraphs: readonly BidiParagraph[] }>;

/** Synchronous convenience over the cooperative kernel. Materializing full arrays costs proportional work. */
export function resolveBidi(text: string, direction: BidiDirection = "ltr"): BidiText {
    if (typeof text !== "string") throw new TypeError("Invalid bidi input.");
    const cursor = new BidiCursor(text, { direction }); let step = cursor.next(65536);
    while (step.status === "running") step = cursor.next(65536);
    return step.result!.materialize();
}
