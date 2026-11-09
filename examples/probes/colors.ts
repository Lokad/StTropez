import type { TextBuffer } from "../../src/index.ts";
import { navigationLimits, validateNavigationDocuments } from "./navigation.ts";
import type { NavigationDocument } from "./navigation.ts";
import { validateProjectEdits } from "./project-commands.ts";
import type { ServerEdit } from "./project-commands.ts";
export const colorLimits = Object.freeze({ literal: 96, references: 1024, page: 64 });
export type Rgba = Readonly<{ red: number; green: number; blue: number; alpha: number }>;
export type ColorReference = Readonly<{ from: number; to: number; text: string; label: string; color: Rgba }>;
export type ColorFault = "malformed" | "failure" | "incomplete" | "markup";
export type ColorsInput = NavigationDocument & Readonly<{ id: number; delay: number; fault?: ColorFault }>;
export type ColorsResult = Readonly<{ operation: "colors-result"; id: number; document: string; revision: number; complete: true; truncated: boolean; colors: readonly ColorReference[] }>;
export type ColorPresentationInput = ColorsInput & Readonly<{ discovery: number; reference: ColorReference; proposed: Rgba }>;
export type ColorPresentation = Readonly<{ id: "hex" | "rgba"; label: string; edits: readonly ServerEdit[] }>;
export type ColorPresentationsResult = Readonly<{ operation: "color-presentations-result"; id: number; discovery: number; document: string; revision: number; from: number; to: number; proposed: Rgba; complete: true; presentations: readonly ColorPresentation[] }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const boundary = (char: string | undefined) => !!char && /[\p{L}\p{N}\p{M}\p{Pc}\u200c\u200d-]/u.test(char);
export function validateRgba(v: unknown): Rgba {
    if (!record(v) || ![v.red, v.green, v.blue, v.alpha].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid normalized RGBA channels.");
    return Object.freeze({ red: v.red as number, green: v.green as number, blue: v.blue as number, alpha: v.alpha as number });
}
export const sameColor = (a: Rgba, b: Rgba): boolean => [a.red - b.red, a.green - b.green, a.blue - b.blue, a.alpha - b.alpha].every(n => Math.abs(n) <= 1e-12);
/** Bounded literal policy shared with host form validation, never a whole-source parser. */
export function parseColor(text: string): Rgba | undefined {
    if (!text.length || text.length > colorLimits.literal) return;
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) {
        const hex = text.length <= 5 ? Array.from(text.slice(1), c => c + c).join("") : text.slice(1), values = [0, 2, 4, 6].map((at, i) => i === 3 && hex.length === 6 ? 1 : parseInt(hex.slice(at, at + 2), 16) / 255);
        return validateRgba({ red: values[0], green: values[1], blue: values[2], alpha: values[3] });
    }
    const fn = /^(rgb|rgba)\(([^()]*)\)$/i.exec(text); if (!fn) return;
    const values = fn[2]!.split(",").map(part => /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%)?$/i.exec(part.trim()));
    if (values.length !== (fn[1]!.toLowerCase() === "rgb" ? 3 : 4) || values.some(v => !v || !Number.isFinite(Number(v[1])))) return;
    if (values.slice(0, 3).some(v => !!v![2] !== !!values[0]![2])) return;
    const channels = values.map((v, i) => Math.max(0, Math.min(1, Number(v![1]) / (v![2] ? 100 : i === 3 ? 1 : 255))));
    return validateRgba({ red: channels[0], green: channels[1], blue: channels[2], alpha: channels[3] ?? 1 });
}
export function hexColor(color: Rgba): string | undefined {
    const values = [color.red, color.green, color.blue, color.alpha]; if (values.some(n => Math.abs(n * 255 - Math.round(n * 255)) > 1e-9)) return;
    return "#" + values.slice(0, color.alpha === 1 ? 3 : 4).map(n => Math.round(n * 255).toString(16).padStart(2, "0")).join("");
}
export const rgbaColor = (color: Rgba): string => `rgba(${color.red * 255}, ${color.green * 255}, ${color.blue * 255}, ${color.alpha})`;
export function validateColorsInput(v: unknown): ColorsInput {
    if (!record(v) || !integer(v.id) || !v.id || typeof v.delay !== "number" || !Number.isFinite(v.delay) || v.delay < 0 || v.delay > 1000
        || v.fault !== undefined && !["malformed", "failure", "incomplete", "markup"].includes(v.fault as string)) throw new Error("Invalid color capture.");
    const doc = validateNavigationDocuments([v])[0]!; return Object.freeze({ ...doc, id: v.id, delay: v.delay, ...(v.fault === undefined ? {} : { fault: v.fault as ColorFault }) });
}
function reference(v: unknown, buffer: TextBuffer): ColorReference {
    if (!record(v) || !integer(v.from) || !integer(v.to) || v.to <= v.from || v.to > buffer.length || v.to - v.from > colorLimits.literal || typeof v.text !== "string" || v.text.length !== v.to - v.from
        || typeof v.label !== "string" || !v.label.length || v.label.length > 128 || buffer.slice(v.from, v.to) !== v.text) throw new Error("Invalid captured color reference.");
    const parsed = parseColor(v.text), color = validateRgba(v.color), before = Array.from(buffer.slice(Math.max(0, v.from - 2), v.from)).at(-1), after = Array.from(buffer.slice(v.to, Math.min(buffer.length, v.to + 2)))[0];
    if (!parsed || !sameColor(parsed, color) || boundary(before) || boundary(after)) throw new Error("Color range or channels do not match the source.");
    return Object.freeze({ from: v.from, to: v.to, text: v.text, label: v.label, color });
}
/** Streaming literal scanner: at most96 retained token units and one carried surrogate. */
class ColorScanner {
    private offset = 0;
    private high = "";
    private previous = "";
    private mode: "none" | "prefix" | "hex" | "function" = "none";
    private from = 0;
    private units = 0;
    private text = "";
    private pending: ColorReference | undefined;
    private readonly accept: (color: ColorReference) => void;
    constructor(accept: (color: ColorReference) => void) { this.accept = accept; }
    private candidate(to: number): ColorReference | undefined { const color = this.units <= colorLimits.literal ? parseColor(this.text) : undefined; return color ? Object.freeze({ from: this.from, to, text: this.text, color, label: hexColor(color) ?? rgbaColor(color) }) : undefined; }
    private append(char: string): void { this.units += char.length; if (this.units <= colorLimits.literal) this.text += char; }
    private point(char: string): void {
        const at = this.offset; if (this.pending) { if (!boundary(char)) this.accept(this.pending); this.pending = undefined; }
        let consumed = false;
        if (this.mode === "hex") {
            if (/^[\da-f]$/i.test(char)) { this.append(char); consumed = true; }
            else { const color = !boundary(char) ? this.candidate(at) : undefined; if (color) this.accept(color); this.mode = "none"; }
        } else if (this.mode === "prefix") {
            this.append(char); const text = this.text.toLowerCase(); if (text === "rgb(" || text === "rgba(") this.mode = "function";
            else if (!["r", "rg", "rgb", "rgba"].includes(text)) this.mode = "none"; consumed = true;
        } else if (this.mode === "function") {
            this.append(char); if (char === ")") { this.pending = this.candidate(at + char.length); this.mode = "none"; } consumed = true;
        }
        if (!consumed && this.mode === "none" && !boundary(this.previous)) {
            if (char === "#" || char.toLowerCase() === "r") { this.from = at; this.units = 0; this.text = ""; this.mode = char === "#" ? "hex" : "prefix"; this.append(char); }
        }
        this.previous = char; this.offset += char.length;
    }
    feed(chunk: string): void { let text = this.high + chunk; this.high = ""; if (/[\ud800-\udbff]$/.test(text)) { this.high = text.at(-1)!; text = text.slice(0, -1); } for (const char of text) this.point(char); }
    finish(): void { if (this.high) { this.point(this.high); this.high = ""; } if (this.mode === "hex") { const color = this.candidate(this.offset); if (color) this.accept(color); } if (this.pending) this.accept(this.pending); this.pending = undefined; }
}
export class DocumentColorsCursor {
    private readonly input: ColorsInput;
    private readonly buffer: TextBuffer;
    private readonly scanner: ColorScanner;
    private readonly colors: ColorReference[] = [];
    private truncated = false;
    private from = 0;
    private result: ColorsResult | undefined;
    constructor(capture: unknown, buffer: TextBuffer) { this.input = validateColorsInput(capture); if (buffer.length !== this.input.length) throw new Error("Missing color source."); this.buffer = buffer;
        this.scanner = new ColorScanner(color => { if (this.colors.length === colorLimits.references) this.truncated = true; else this.colors.push(color); }); }
    next(): Readonly<{ work: number; result?: ColorsResult }> {
        if (this.result) return { work: this.from, result: this.result };
        const to = Math.min(this.input.length, this.from + navigationLimits.chunkUnits); this.scanner.feed(this.buffer.slice(this.from, to)); this.from = to;
        if (this.from !== this.input.length) return { work: this.from }; this.scanner.finish();
        this.result = Object.freeze({ operation: "colors-result", id: this.input.id, document: this.input.document, revision: this.input.revision, complete: true, truncated: this.truncated, colors: Object.freeze(this.colors.slice()) }); return { work: this.from, result: this.result };
    }
}
export function validateColorsResult(v: unknown, input: ColorsInput, buffer: TextBuffer): ColorsResult {
    if (buffer.length !== input.length || !record(v) || v.operation !== "colors-result" || v.id !== input.id || v.document !== input.document || v.revision !== input.revision || v.complete !== true || typeof v.truncated !== "boolean" || !Array.isArray(v.colors) || v.colors.length > colorLimits.references) throw new Error("Invalid or incomplete document colors.");
    if (v.truncated) throw new Error("Document colors exceed1,024 references; narrow the source."); let end = -1;
    const colors = v.colors.map((value: unknown) => { const color = reference(value, buffer); if (color.from < end) throw new Error("Overlapping or unordered color references."); end = color.to; return color; });
    return Object.freeze({ operation: "colors-result", id: input.id, document: input.document, revision: input.revision, complete: true, truncated: false, colors: Object.freeze(colors) });
}
export function validateColorPresentationInput(v: unknown, buffer: TextBuffer): ColorPresentationInput {
    const input = validateColorsInput(v); if (!record(v) || !integer(v.discovery) || !v.discovery || buffer.length !== input.length) throw new Error("Invalid presentation identity.");
    return Object.freeze({ ...input, discovery: v.discovery, reference: reference(v.reference, buffer), proposed: validateRgba(v.proposed) });
}
export function provideColorPresentations(input: ColorPresentationInput): ColorPresentationsResult {
    const values: readonly ["hex" | "rgba", string | undefined][] = [["hex", hexColor(input.proposed)], ["rgba", rgbaColor(input.proposed)]];
    const presentations = values.flatMap(([id, text]) => text === undefined ? [] : [{ id, label: text, edits: [{ document: input.document, revision: input.revision, edits: [{ from: input.reference.from, to: input.reference.to, insert: text }] }] }]);
    return validateColorPresentationsResult({ operation: "color-presentations-result", id: input.id, discovery: input.discovery, document: input.document, revision: input.revision, from: input.reference.from, to: input.reference.to, proposed: input.proposed, complete: true, presentations }, input);
}
export function validateColorPresentationsResult(v: unknown, input: ColorPresentationInput): ColorPresentationsResult {
    if (!record(v) || v.operation !== "color-presentations-result" || v.id !== input.id || v.discovery !== input.discovery || v.document !== input.document || v.revision !== input.revision || v.from !== input.reference.from || v.to !== input.reference.to || v.complete !== true || !sameColor(validateRgba(v.proposed), input.proposed) || !Array.isArray(v.presentations) || !v.presentations.length || v.presentations.length > 2) throw new Error("Invalid or incomplete color presentations.");
    const ids = new Set<string>(), presentations = v.presentations.map((p: unknown): ColorPresentation => {
        if (!record(p) || p.id !== "hex" && p.id !== "rgba" || ids.has(p.id) || typeof p.label !== "string" || !p.label.length || p.label.length > 128) throw new Error("Invalid color presentation choice."); ids.add(p.id);
        const edits = validateProjectEdits(p.edits, [input]), primary = edits.flatMap(at => at.edits).find(e => e.from === input.reference.from && e.to === input.reference.to), parsed = primary && parseColor(primary.insert);
        if (!parsed || !sameColor(parsed, input.proposed)) throw new Error("Presentation must preserve the requested color at the captured range.");
        return Object.freeze({ id: p.id, label: p.label, edits });
    });
    return Object.freeze({ operation: "color-presentations-result", id: input.id, discovery: input.discovery, document: input.document, revision: input.revision, from: input.reference.from, to: input.reference.to, proposed: input.proposed, complete: true, presentations: Object.freeze(presentations) });
}
