import { validateTextEdits } from "../../src/index.ts";
import type { TextBuffer, TextEdit } from "../../src/index.ts";

export type DomainAnnotation = Readonly<{ id: string; from: number; to: number; label: string }>;
export type DomainFold = Readonly<{ id: string; from: number; to: number }>;
export type DomainInput = Readonly<{ id: number; revision: number; buffer: TextBuffer; kind: "analyze" | "import"; module: string }>;
export type DomainResult = Readonly<{ id: number; revision: number; folds: readonly DomainFold[]; annotations: readonly DomainAnnotation[]; edits: readonly TextEdit[] }>;
export type DomainProvider = Readonly<{ run: (input: DomainInput, signal: AbortSignal, progress: (units: number) => void) => Promise<unknown> }>;
export const domainLimits = Object.freeze({ regions: 4096, labelUnits: 256, resultTextUnits: 65536, prefixUnits: 512, depth: 128 });
export const validDomainModule = (value: string): boolean => /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(value);

/** Local host fixture grammar, not a parser in the editor runtime.
 * Headers: // #region stable-id Label; closers: // #endregion stable-id.
 * Import placement/format is this provider's policy; hosts can supply another provider.
 */
export class DomainCursor {
    private readonly chunks: Iterator<string>;
    private chunk = "";
    private at = 0;
    private offset = 0;
    private lineStart = 0;
    private prefix = "";
    private truncated = false;
    private ending: string | undefined;
    private previous = "";
    private readonly stack: { id: string; from: number }[] = [];
    private readonly ids = new Set<string>();
    private readonly folds: DomainFold[] = [];
    private readonly annotations: DomainAnnotation[] = [];
    private labelUnits = 0;
    private imported = false;
    private finished = false;
    private result: DomainResult | undefined;
    private readonly input: DomainInput;
    private readonly importLine: ((from: number, to: number, module: string) => void) | undefined;
    constructor(input: DomainInput, importLine?: (from: number, to: number, module: string) => void) {
        this.input = input;
        this.importLine = importLine;
        if (!validDomainModule(input.module)) throw new Error("Choose a bounded module identifier.");
        this.chunks = input.buffer.chunks()[Symbol.iterator]();
    }
    private line(end: number): void {
        const raw = this.prefix.endsWith("\r") ? this.prefix.slice(0, -1) : this.prefix;
        const text = this.lineStart === 0 && raw.startsWith("\ufeff") ? raw.slice(1) : raw;
        if (this.importLine && !this.truncated) {
            const match = /^import "([A-Za-z][A-Za-z0-9_./-]{0,63})";$/.exec(text);
            if (match) { const from = this.lineStart + (this.lineStart === 0 && raw.startsWith("\ufeff") ? 1 : 0) + 8; this.importLine(from, from + match[1]!.length, match[1]!); }
        }
        if (text === `import ${JSON.stringify(this.input.module)};`) this.imported = true;
        if (this.input.kind === "import") { this.prefix = ""; this.truncated = false; this.lineStart = end; return; }
        const open = /^\/\/ #region ([A-Za-z_][A-Za-z0-9_.-]{0,63})(?: (.*))?$/.exec(text);
        const close = /^\/\/ #endregion ([A-Za-z_][A-Za-z0-9_.-]{0,63})$/.exec(text);
        if (this.truncated && /^\/\/ #(?:end)?region\b/.test(text)) throw new Error("Domain header exceeds the supported label size.");
        if (open) {
            const id = open[1]!, label = open[2] || id;
            if (this.ids.has(id) || this.ids.size >= domainLimits.regions || this.stack.length >= domainLimits.depth) throw new Error("Domain regions need unique identities and bounded nesting/count.");
            if (label.length > domainLimits.labelUnits || (this.labelUnits += label.length) > domainLimits.resultTextUnits) throw new Error("Domain labels exceed the supported size.");
            this.ids.add(id); this.stack.push({ id, from: this.lineStart });
            this.annotations.push(Object.freeze({ id, from: this.lineStart, to: this.lineStart + raw.length, label }));
        } else if (close) {
            const header = this.stack.pop();
            if (!header || header.id !== close[1]) throw new Error("Domain region closers must match the nested header identity.");
            this.folds.push(Object.freeze({ id: header.id, from: header.from, to: end }));
        }
        this.prefix = ""; this.truncated = false; this.lineStart = end;
    }
    next(units = 16384): Readonly<{ status: "running" | "done"; work: number; result?: DomainResult }> {
        if (!Number.isSafeInteger(units) || units < 1) throw new RangeError("Expected a positive work budget.");
        if (this.finished) return { status: "done", work: this.offset, result: this.result! };
        let work = 0;
        while (this.offset < this.input.buffer.length && work < units) {
            if (this.at === this.chunk.length) { const next = this.chunks.next(); if (next.done) throw new Error("Missing captured domain text."); this.chunk = next.value; this.at = 0; }
            const char = this.chunk[this.at++]!; this.offset++; work++;
            if (char === "\n") { this.ending ??= this.previous === "\r" ? "\r\n" : "\n"; this.line(this.offset); }
            else if (this.prefix.length < domainLimits.prefixUnits) this.prefix += char; else this.truncated = true;
            this.previous = char;
        }
        if (this.offset < this.input.buffer.length) return { status: "running", work: this.offset };
        if (this.lineStart < this.offset) this.line(this.offset);
        if (this.stack.length) throw new Error("Close every domain region before discovery.");
        const from = this.input.buffer.slice(0, Math.min(1, this.input.buffer.length)) === "\ufeff" ? 1 : 0;
        const edits = this.input.kind === "import" && !this.imported ? [Object.freeze({ from, to: from, insert: `import ${JSON.stringify(this.input.module)};${this.ending ?? "\n"}` })] : [];
        this.finished = true; this.chunk = "";
        this.result = Object.freeze({ id: this.input.id, revision: this.input.revision, folds: Object.freeze(this.folds.slice()), annotations: Object.freeze(this.annotations.slice()), edits: Object.freeze(edits) });
        return { status: "done", work: this.offset, result: this.result };
    }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const range = (value: Record<string, unknown>, length: number): boolean => Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
    && typeof value.from === "number" && typeof value.to === "number" && value.from >= 0 && value.to > value.from && value.to <= length;
export function validateDomainResult(value: unknown, input: DomainInput): DomainResult {
    if (!record(value) || value.id !== input.id || value.revision !== input.revision || !Array.isArray(value.folds) || !Array.isArray(value.annotations) || !Array.isArray(value.edits)
        || value.folds.length > domainLimits.regions || value.annotations.length > domainLimits.regions || value.edits.length > 256) throw new Error("Invalid captured domain result.");
    const ids = new Set<string>(), noteIds = new Set<string>(); let textUnits = 0;
    const folds = value.folds.map((item: unknown) => {
        if (!record(item) || typeof item.id !== "string" || !item.id.length || item.id.length > 128 || ids.has(item.id) || !range(item, input.buffer.length)) throw new Error("Invalid domain fold identity/range.");
        ids.add(item.id); return Object.freeze({ id: item.id, from: item.from as number, to: item.to as number });
    });
    const annotations = value.annotations.map((item: unknown) => {
        if (!record(item) || typeof item.id !== "string" || !item.id.length || item.id.length > 128 || noteIds.has(item.id) || !range(item, input.buffer.length)
            || typeof item.label !== "string" || !item.label.length || item.label.length > domainLimits.labelUnits || (textUnits += item.label.length) > domainLimits.resultTextUnits) throw new Error("Invalid domain annotation.");
        noteIds.add(item.id); return Object.freeze({ id: item.id, from: item.from as number, to: item.to as number, label: item.label });
    });
    const edits = value.edits.map((item: unknown) => {
        if (!record(item) || typeof item.insert !== "string" || (textUnits += item.insert.length) > domainLimits.resultTextUnits) throw new Error("Invalid domain import edit.");
        return Object.freeze({ from: item.from as number, to: item.to as number, insert: item.insert });
    });
    validateTextEdits(input.buffer.length, edits);
    if (input.kind === "analyze" && edits.length) throw new Error("Discovery cannot edit source text.");
    return Object.freeze({ id: input.id, revision: input.revision, folds: Object.freeze(folds), annotations: Object.freeze(annotations), edits: Object.freeze(edits) });
}

export class FixtureDomainProvider implements DomainProvider {
    delay = 25;
    fault: "malformed" | "failure" | "late" | undefined;
    readonly metrics = { requested: 0, completed: 0, cancelled: 0, turns: 0, work: 0 };
    run(input: DomainInput, signal: AbortSignal, progress: (units: number) => void): Promise<unknown> {
        const fault = this.fault; this.fault = undefined; this.metrics.requested++;
        return new Promise((resolve, reject) => {
            let cursor: DomainCursor | undefined, timer: ReturnType<typeof setTimeout>, ended = false, previousWork = 0;
            const finish = () => { ended = true; clearTimeout(timer); signal.removeEventListener("abort", cancel); };
            const cancel = () => { if (ended || fault === "late") return; finish(); cursor = undefined; this.metrics.cancelled++; reject(new Error("Domain request cancelled.")); };
            const step = () => {
                if (ended) return;
                try {
                    if (signal.aborted && fault !== "late") { cancel(); return; }
                    if (fault === "failure") throw new Error("Synthetic domain provider failure.");
                    cursor ??= new DomainCursor(input); const result = cursor.next(); this.metrics.turns++; this.metrics.work += result.work - previousWork; previousWork = result.work; progress(result.work);
                    if (ended) return;
                    if (result.status === "running") { timer = setTimeout(step, 0); return; }
                    finish(); this.metrics.completed++; cursor = undefined;
                    resolve(fault === "malformed" ? { ...result.result, annotations: [{ id: "invalid", from: 0, to: input.buffer.length + 1, label: "Invalid result" }] } : result.result);
                } catch (error) { finish(); cursor = undefined; reject(error); }
            };
            signal.addEventListener("abort", cancel, { once: true }); timer = setTimeout(step, this.delay);
        });
    }
}
