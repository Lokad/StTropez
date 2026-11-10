import { textDifference } from "../../src/index.ts";
import type { TextEdit } from "../../src/index.ts";
import { transferValidation } from "./transfers.ts";

export type InstructionField = "destination" | "batchSize";
type Token = Readonly<{ from: number; to: number; raw: string; text: string; string: boolean }>;
export type ParsedInstruction = Readonly<{ raw: string; close: number; members: number; fields: Readonly<Partial<Record<InstructionField, Token>>>;
    values: Readonly<Record<InstructionField, string>>; validation: string | null }>;
export const instructionLimit = 4096;
const prefix = /^[\t ]*\/\/ @transfer[\t ]+/;

/** Native JSON validation plus bounded top-level spans; unknown tokens are never serialized. */
export function parseInstruction(raw: string): ParsedInstruction {
    if (raw.length > instructionLimit) throw new Error("Instruction line exceeds 4,096 UTF-16 units.");
    const start = prefix.exec(raw)?.[0].length; if (start === undefined) throw new Error("Use one // @transfer JSON object on this line.");
    let value: unknown; try { value = JSON.parse(raw.slice(start)); } catch { throw new Error("Instruction JSON is incomplete or invalid. Correct the source to resume form editing."); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Instruction JSON must be an object.");
    let at = start; const space = () => { while (raw[at] === " " || raw[at] === "\t") at++; };
    const stringEnd = () => { at++; while (at < raw.length) { const c = raw[at++]; if (c === "\\") at++; else if (c === '"') return; } };
    space(); at++; space(); let members = 0;
    const fields: Partial<Record<InstructionField, Token>> = {};
    while (raw[at] !== "}") {
        const nameFrom = at; stringEnd(); const name = JSON.parse(raw.slice(nameFrom, at)) as string; space(); at++; space();
        const from = at; let depth = 0;
        while (at < raw.length) { const c = raw[at]; if (c === '"') { stringEnd(); continue; }
            if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") { if (depth === 0) break; depth--; }
            else if (c === "," && depth === 0) break; at++;
        }
        let to = at; while (raw[to - 1] === " " || raw[to - 1] === "\t") to--;
        if (name === "destination" || name === "batchSize") {
            if (fields[name]) throw new Error(`Duplicate ${name} fields are ambiguous. Correct the source to resume form editing.`);
            const token = raw.slice(from, to), decoded: unknown = JSON.parse(token);
            fields[name] = Object.freeze({ from, to, raw: token, text: typeof decoded === "string" ? decoded : token, string: typeof decoded === "string" });
        }
        members++; if (raw[at] === ",") { at++; space(); } else break;
    }
    const values = Object.freeze({ destination: fields.destination?.text ?? "", batchSize: fields.batchSize?.text ?? "" });
    const validation = fields.destination && !fields.destination.string ? "Instruction destination must be a JSON string."
        : fields.batchSize && !fields.batchSize.string ? "Instruction batch size must be a JSON string." : transferValidation(values);
    return Object.freeze({ raw, close: at, members, fields: Object.freeze(fields), values, validation });
}

export function instructionEdit(parsed: ParsedInstruction, field: InstructionField, value: string): TextEdit | null {
    const token = parsed.fields[field]; if (token?.string && token.text === value) return null;
    const encoded = JSON.stringify(value); let edit: TextEdit;
    if (token?.string) {
        const diff = textDifference(token.text, value)!; const offsets = [1]; let at = 1;
        while (at < token.raw.length - 1) { at += token.raw[at] === "\\" ? token.raw[at + 1] === "u" ? 6 : 2 : 1; offsets.push(at); }
        edit = { from: token.from + offsets[diff.from]!, to: token.from + offsets[diff.to]!, insert: JSON.stringify(diff.insert).slice(1, -1) };
    } else edit = token ? { from: token.from, to: token.to, insert: encoded }
        : { from: parsed.close, to: parsed.close, insert: `${parsed.members ? "," : ""} ${JSON.stringify(field)}: ${encoded}` };
    if (parsed.raw.length + edit.insert.length - (edit.to - edit.from) > instructionLimit) throw new Error("Instruction edit exceeds the 4,096-unit line limit. Input is retained for recovery.");
    return Object.freeze(edit);
}
