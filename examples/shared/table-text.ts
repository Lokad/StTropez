/** Host-owned table conversion; no document, storage or clipboard APIs. */
export const tableLimits = Object.freeze({ textUnits: 1024 * 1024, htmlUnits: 256 * 1024, outputUnits: 4 * 1024 * 1024, rows: 10000, columns: 1024, cells: 100000 });
/** One UTF-16 unit, or a multi-character delimiter/control name. */
export type TableToken = string;
export type TableResult = Readonly<{ text: string; rows: number; columns: number; cells: number }>;
export type TableProgress = Readonly<{ done: boolean; work: number; totalWork: number; outputUnits: number; result?: TableResult }>;

/** One unit per consumed UTF-16 unit or delimiter token. Quotes at field start delimit TSV. */
export function* tsvTokens(text: string): Generator<TableToken> {
    if (text.length > tableLimits.textUnits) throw new RangeError("Table text exceeds 1 Mi UTF-16 units.");
    if (!text.length) return;
    let first = true, quoted = false, closed = false, endedRow = false;
    for (let at = 0; at < text.length; at++) {
        const c = text[at]!; endedRow = false;
        if (first) { first = false; if (c === '"') { quoted = true; yield "tick"; continue; } }
        if (quoted) {
            if (c === '"') {
                if (text[at + 1] === '"') { at++; yield "tick"; yield '"'; }
                else { quoted = false; closed = true; yield "tick"; }
            } else yield c;
        } else if (c === "\t") { yield "cell"; first = true; closed = false; }
        else if (c === "\r" || c === "\n") {
            if (c === "\r" && text[at + 1] === "\n") { at++; yield "tick"; }
            yield "row"; first = true; closed = false; endedRow = true;
        } else { if (closed) throw new RangeError("Unexpected text after a quoted table cell."); yield c; }
    }
    if (quoted) throw new RangeError("Unclosed quoted table cell.");
    if (!endedRow) yield "end";
}

/** Every cell is quoted; output records use CRLF, preserving raw cell contents. */
export class TableTextFormatter {
    private tokens: Generator<TableToken> | undefined;
    private parts: string[] = [];
    private chunk = "";
    private units = 0;
    private total = 0;
    private rows = 0;
    private columns = 0;
    private column = 0;
    private cells = 0;
    private open = false;
    private finished: TableResult | undefined;
    constructor(tokens: Generator<TableToken>) { this.tokens = tokens; }
    private write(value: string): void {
        if (this.units + value.length > tableLimits.outputUnits) throw new RangeError("Converted table exceeds 4 Mi UTF-16 units.");
        this.units += value.length; this.chunk += value;
        if (this.chunk.length >= 4096) { this.parts.push(this.chunk); this.chunk = ""; }
    }
    private start(): void {
        if (this.open) return;
        if (++this.cells > tableLimits.cells || ++this.column > tableLimits.columns) throw new RangeError("Table exceeds the cell/column limit.");
        this.write('"'); this.open = true;
    }
    advance(budget = 8192): TableProgress {
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 65536) throw new RangeError("Invalid table work budget.");
        if (this.finished) return Object.freeze({ done: true, work: 0, totalWork: this.total, outputUnits: this.units, result: this.finished });
        if (!this.tokens) throw new Error("Table conversion is disposed.");
        let work = 0;
        try {
            while (work < budget) {
                const next = this.tokens.next(); work++; this.total++;
                if (next.done) {
                    if (this.open || this.column) throw new Error("Incomplete table token stream.");
                    this.finished = Object.freeze({ text: this.parts.join("") + this.chunk, rows: this.rows, columns: this.columns, cells: this.cells });
                    this.tokens.return(undefined); this.tokens = undefined; this.parts = []; this.chunk = "";
                    return Object.freeze({ done: true, work, totalWork: this.total, outputUnits: this.units, result: this.finished });
                }
                const token = next.value;
                if (token === "tick") continue;
                this.start();
                if (token.length === 1) {
                    this.write(token === '"' ? '""' : token); continue;
                }
                this.write('"'); this.open = false;
                if (token === "cell") { this.write(","); continue; }
                if (token !== "row" && token !== "end") throw new Error("Unknown table delimiter.");
                if (this.columns && this.column !== this.columns) throw new RangeError("Table rows have different cell counts.");
                this.columns = this.column; this.column = 0;
                if (++this.rows > tableLimits.rows) throw new RangeError("Table exceeds 10,000 rows.");
                if (token === "row") this.write("\r\n");
            }
            return Object.freeze({ done: false, work, totalWork: this.total, outputUnits: this.units });
        } catch (error) { this.dispose(); throw error; }
    }
    dispose(): void { this.tokens?.return(undefined); this.tokens = undefined; this.parts = []; this.chunk = ""; this.finished = undefined; }
}
