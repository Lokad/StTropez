import { applyTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { PositionMap } from "./positions.ts";

export type LineEnding = "lf" | "crlf" | "cr";
export type ImportedText = Readonly<{ text: string; detected: LineEnding | "mixed" | "none"; mapping: PositionMap }>;

/** Import/export conversion is explicit; UTF-16 text is never silently repaired or normalized. */
export function importText(text: string, policy: "preserve" | "lf"): ImportedText {
    if (policy !== "preserve" && policy !== "lf") throw new TypeError("Unknown newline import policy.");
    const kinds = new Set<LineEnding>(), edits: TextEdit[] = [];
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        const kind: LineEnding = match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf";
        kinds.add(kind);
        if (policy === "lf" && kind === "crlf") edits.push({ from: match.index, to: match.index + 1, insert: "" });
        else if (policy === "lf" && kind === "cr") edits.push({ from: match.index, to: match.index + 1, insert: "\n" });
    }
    return Object.freeze({ text: edits.length ? applyTextEdits(text, edits) : text,
        detected: kinds.size === 0 ? "none" : kinds.size === 1 ? [...kinds][0]! : "mixed", mapping: new PositionMap(text.length, edits) });
}

export function exportText(text: string, ending: LineEnding | "preserve"): Readonly<{ text: string; mapping: PositionMap }> {
    if (!["lf", "crlf", "cr", "preserve"].includes(ending)) throw new TypeError("Unknown newline export policy.");
    const edits: TextEdit[] = [], insert = ending === "crlf" ? "\r\n" : ending === "cr" ? "\r" : "\n";
    if (ending !== "preserve") for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        if (match[0] !== insert) edits.push({ from: match.index, to: match.index + match[0].length, insert });
    }
    return Object.freeze({ text: edits.length ? applyTextEdits(text, edits) : text, mapping: new PositionMap(text.length, edits) });
}
