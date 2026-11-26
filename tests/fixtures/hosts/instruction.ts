import { anchoredRange } from "../../../src/index.ts";
import type { DocumentView, ResourceTarget, TextBuffer } from "../../../src/index.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import type { HostController } from "./controller.ts";
import { instructionEdit, instructionLimit, parseInstruction } from "./instruction-syntax.ts";
import type { InstructionField, ParsedInstruction } from "./instruction-syntax.ts";

export type InstructionCapture = Readonly<{ target: ResourceTarget; generation: number; authority: number; field: InstructionField; token: string | null; revision: number; from: number; to: number }>;
type Span = Readonly<{ from: number; to: number }>;
type State = Readonly<{ active: boolean; located: boolean; generation: number; revision: number; from: number; to: number; line: number;
    values: Readonly<Record<InstructionField, string>>; canEdit: boolean; validation: string | null; message: string; pendingCopy: boolean }>;
type Copy = Readonly<{ destination: ResourceTarget; source: ResourceTarget; revision: number; version: string | null; authority: string;
    sourceRevision: number; values: Readonly<Record<InstructionField, string>>; stale: () => boolean; stop: () => void }>;

/** One explicit host instruction anchor. The document remains the sole field-value authority. */
export class TransferInstruction {
    private readonly host: HostController;
    private readonly cell = new HostCell<State>({ active: false, located: false, generation: 0, revision: 0, from: 0, to: 0, line: 0,
        values: { destination: "", batchSize: "" }, canEdit: false, validation: null, message: "Anchor a transfer instruction at the primary caret.", pendingCopy: false });
    readonly state = this.cell.observable;
    private span: Span | undefined;
    private parsed: ParsedInstruction | undefined;
    private anchors = new WeakMap<TextBuffer, Span | null>();
    private buffer: TextBuffer | undefined;
    private revision = 0;
    private authority = 0;
    private authorityText = "";
    private stops: (() => void)[] = [];
    private copy: Copy | undefined;
    private disposed = false;
    private reads = 0;
    constructor(host: HostController) { this.host = host; }
    private permissions(): string { const m = this.host.source.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit]); }
    private publish(patch: Partial<State>): void { if (!this.disposed) this.cell.set({ ...this.cell.get(), ...patch }); }
    private line(buffer: TextBuffer, offset: number): Span {
        const line = buffer.lineAt(Math.min(offset, buffer.length)), from = buffer.offsetAt(line); let to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        const tail = buffer.slice(Math.max(from, to - 2), to); this.reads += tail.length;
        if (tail.endsWith("\r\n")) to -= 2; else if (tail.endsWith("\r") || tail.endsWith("\n")) to--;
        return Object.freeze({ from, to });
    }
    readonly anchor = (offset: number): void => {
        if (this.disposed) return; const d = this.host.workspace.document(this.host.source.id);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > d.buffer.length) throw new RangeError("Instruction anchor is outside the document.");
        this.cancelCopy(); this.stops.forEach(stop => stop()); this.stops = [];
        this.span = this.line(d.buffer, offset); this.buffer = d.buffer; this.revision = d.revision;
        this.anchors = new WeakMap(); this.anchors.set(d.buffer, this.span); this.authorityText = this.permissions(); this.authority++;
        this.publish({ active: true, located: false, canEdit: false, values: { destination: "", batchSize: "" }, generation: this.cell.get().generation + 1,
            message: "Source-backed instruction. Field edits change source; copying into transfer settings is explicit." });
        this.stops.push(this.host.workspace.observeDocument(d.id).subscribe(() => this.refresh()), this.host.source.metadata.subscribe(() => {
            const next = this.permissions(); if (next !== this.authorityText) { this.authority++; this.authorityText = next; } this.refresh();
        })); this.refresh();
    };
    private refresh(): void {
        if (this.disposed || !this.cell.get().active) return;
        const d = this.host.workspace.document(this.host.source.id), m = this.host.source.metadata.getSnapshot(); this.reads = 0;
        if (d.buffer !== this.buffer) {
            if (this.anchors.has(d.buffer)) this.span = this.anchors.get(d.buffer) ?? undefined;
            else if (this.span && d.change?.previousRevision === this.revision) {
                const old = this.span, range = anchoredRange(d.change.mapping.oldLength, old.from, old.to, { onDelete: "collapse" });
                const mapped = d.change.mapping.mapRange(range)!;
                if (mapped.from === mapped.to && old.from !== old.to) {
                    const start = d.change.mapping.map(old.from, "before"), candidate = this.line(d.buffer, start.offset);
                    const prefix = d.buffer.slice(candidate.from, Math.min(candidate.to, candidate.from + instructionLimit)); this.reads += prefix.length;
                    this.span = !start.deleted && candidate.from === start.offset && /^[\t ]*\/\/ @transfer[\t ]+/.test(prefix) ? candidate : undefined;
                } else this.span = this.line(d.buffer, mapped.from);
            } else this.span = undefined;
            this.anchors.set(d.buffer, this.span ?? null);
        }
        this.buffer = d.buffer; this.revision = d.revision; this.parsed = undefined; let problem: string | null = null;
        if (this.span) try {
            if (this.span.to - this.span.from > instructionLimit) throw new Error("Instruction line exceeds 4,096 UTF-16 units. Edit it in source.");
            const raw = d.buffer.slice(this.span.from, this.span.to); this.reads += raw.length; this.parsed = parseInstruction(raw); problem = this.parsed.validation;
        } catch (error) { problem = (error as Error).message; }
        else problem = "Instruction anchor was removed or replaced. Undo or anchor again.";
        this.publish({ located: !!this.span, revision: d.revision, from: this.span?.from ?? 0, to: this.span?.to ?? 0, line: this.span ? d.buffer.lineAt(this.span.from) : 0,
            values: this.parsed?.values ?? this.cell.get().values, canEdit: !!this.parsed && m.state === "ready" && m.capabilities.edit.includes("human"),
            validation: problem });
    }
    capture(field: InstructionField): InstructionCapture | null {
        if (!this.parsed || !this.span || !this.cell.get().canEdit || this.disposed) return null;
        const token = this.parsed.fields[field]; return Object.freeze({ target: this.host.workspace.captureResource(this.host.source.id), generation: this.cell.get().generation,
            authority: this.authority, field, token: token?.raw ?? null, revision: this.revision, from: this.span.from + (token?.from ?? this.parsed.close), to: this.span.from + (token?.to ?? this.parsed.close) });
    }
    edit(capture: InstructionCapture, value: string, view?: DocumentView, group?: string): boolean {
        const s = this.cell.get();
        if (this.disposed || !this.parsed || !this.span || !s.canEdit || capture.generation !== s.generation || capture.authority !== this.authority
            || this.host.workspace.resolveResource(capture.target) !== this.host.source || (this.parsed.fields[capture.field]?.raw ?? null) !== capture.token) return this.reject(capture, value, "instruction-target-changed");
        try {
            const edit = instructionEdit(this.parsed, capture.field, value); if (!edit) return true;
            const result = this.host.workspace.edit({ documentId: this.host.source.id, expectedRevision: this.revision, origin: "human",
                edits: [{ from: this.span.from + edit.from, to: this.span.from + edit.to, insert: edit.insert }], history: { kind: "form", ...(group ? { group } : {}) }, ...(view ? { view } : {}) });
            if (!result.applied) return this.reject(capture, value, result.reason); this.publish({ message: "Instruction field edited in source. Save, transfer settings and Run remain independent." }); return true;
        } catch { return this.reject(capture, value, "instruction-edit-unavailable"); }
    }
    reject(capture: InstructionCapture, value: string, reason: string): false {
        if (!this.disposed) { this.host.captureInputConflict(this.host.source.id, { documentId: this.host.source.id, expectedRevision: capture.revision,
            contextFrom: capture.from, reason: `${reason}:${capture.field}`, attemptedText: value });
            this.publish({ message: "Instruction input retained for recovery. Source was not overwritten." }); } return false;
    }
    readonly captureCopy = (): void => {
        if (this.disposed || !this.parsed || this.parsed.validation || !this.span) return; this.cancelCopy();
        const t = this.host.transfer.resource, s = t.getSnapshot(); if (s.state !== "ready" || !s.metadata.capabilities.edit.includes("human")) return;
        const authority = () => { const m = t.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit]); }, stamp = authority(); let stale = false;
        const destination = this.host.workspace.captureResource(t.id);
        this.copy = { destination, source: this.host.workspace.captureResource(this.host.source.id), revision: s.revision, version: s.metadata.serverVersion, authority: stamp,
            sourceRevision: this.revision, values: this.parsed.values, stale: () => stale, stop: t.subscribe(() => { if (authority() !== stamp) stale = true; }) };
        this.publish({ pendingCopy: true, message: "Instruction values captured. Finish the explicit copy into transfer settings." });
    };
    readonly finishCopy = (): void => {
        const copy = this.copy; if (!copy || this.disposed) return; this.copy = undefined; copy.stop();
        try {
            const t = this.host.transfer.resource, s = t.getSnapshot();
            if (this.host.workspace.resolveResource(copy.destination) !== t || !this.host.workspace.resolveResource(copy.source) || copy.stale() || s.state !== "ready" || s.revision !== copy.revision || s.metadata.serverVersion !== copy.version) throw new Error("Copy expired");
            const result = this.host.workspace.updateResource(t, { expectedRevision: copy.revision, origin: "human", value: { ...s.value(), ...copy.values } }); if (!result.applied) throw new Error("Copy unavailable");
            this.publish({ pendingCopy: false, message: "Captured instruction copied into transfer settings. Nothing was saved or run." });
        } catch { this.publish({ pendingCopy: false, message: "Instruction copy expired. Later transfer edits are retained; capture again." }); }
    };
    readonly cancelCopy = (): void => { const copy = this.copy; this.copy = undefined; copy?.stop(); this.publish({ pendingCopy: false }); };
    copyDescription(): string | null { const copy = this.copy; return copy ? `Copy from source revision ${copy.sourceRevision}: destination ${JSON.stringify(copy.values.destination.slice(0, 80))}${copy.values.destination.length > 80 ? "…" : ""}, batch ${JSON.stringify(copy.values.batchSize)}.` : null; }
    readonly clear = (): void => { this.cancelCopy(); this.stops.forEach(stop => stop()); this.stops = []; this.span = undefined; this.parsed = undefined; this.buffer = undefined; this.anchors = new WeakMap(); this.publish({ active: false, located: false, canEdit: false }); };
    debug() { return { active: this.cell.get().active, from: this.span?.from ?? null, to: this.span?.to ?? null, lineReadUnits: this.reads,
        pendingCopy: !!this.copy, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.clear(); this.disposed = true; }
}
