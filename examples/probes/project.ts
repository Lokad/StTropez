import { TextBuffer } from "../../src/index.ts";
import { NavigationSession, navigationLimits, validateNavigationInput } from "./navigation.ts";
import type { NavigationInput } from "./navigation.ts";
import { reviewCapability, reviewHeader, reviewFooter, validateProjectCommand } from "./project-commands.ts";
import type { ProjectCommand, ProjectServerRequest } from "./project-commands.ts";
import { SignatureScanner, validateSignatureInput } from "./signature.ts";
import type { SignatureInput } from "./signature.ts";
export const projectProtocolVersion = 1;
export type ProjectPacket = Readonly<{ version: number; epoch: number; sequence: number; operation: string; [key: string]: unknown }>;
type Document = Readonly<{ revision: number; buffer: TextBuffer }>;
type Stage = { document: string; revision: number; length: number; units: number; from: number; received: number; buffer: TextBuffer };
type Query = { input: NavigationInput; session: NavigationSession; documents: readonly Document[]; ordinal: number; from: number; started: boolean; work: number };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
/** Committed buffers are invisible to incomplete transfers; all positions are raw UTF-16. */
export class ProviderProject {
    readonly epoch: number;
    private sequence = 0;
    private opened = false;
    private readonly documents = new Map<string, Document>();
    private units = 0;
    private stage: Stage | undefined;
    private query: Query | undefined;
    private signature: { input: SignatureInput; buffer: TextBuffer; scanner: SignatureScanner; from: number } | undefined;
    private registered = false;
    private command: { input: ProjectCommand; method: ProjectServerRequest["method"] } | undefined;
    private lastCommand = 0;
    constructor(epoch: number) { if (!integer(epoch) || !epoch) throw new Error("Invalid provider epoch."); this.epoch = epoch; }
    handle(value: unknown): ProjectPacket {
        if (!record(value) || value.version !== projectProtocolVersion || value.epoch !== this.epoch || value.sequence !== this.sequence + 1 || typeof value.operation !== "string") throw new Error("Invalid protocol version, epoch or sequence.");
        const reply = this.apply(value); this.sequence++;
        return Object.freeze({ ...reply, version: projectProtocolVersion, epoch: this.epoch, sequence: this.sequence });
    }
    private apply(value: Record<string, unknown>): Readonly<{ operation: string; [key: string]: unknown }> {
        const ack = (action: string, document?: string, revision?: number, length?: number, received?: number) => ({ operation: "project-ack", action, ...(document === undefined ? {} : { document, revision, length, received }) });
        if (value.operation === "project-hello") { if (this.opened) throw new Error("Provider already initialized."); this.opened = true; return ack("hello"); }
        if (!this.opened) throw new Error("Initialize the provider before documents.");
        if (value.operation === "project-server-result") {
            const command = this.command;
            if (!command || value.request !== command.input.id || typeof value.applied !== "boolean" || typeof value.reason !== "string" || value.reason.length > 256) throw new Error("Invalid server request acknowledgement.");
            if (value.applied && command.method !== "edit") this.registered = command.method === "register";
            this.command = undefined;
            return { operation: "project-command-result", request: command.input.id, applied: value.applied, reason: value.reason, registered: this.registered };
        }
        if (this.command) throw new Error("Acknowledge the server request before another operation.");
        if (value.operation === "project-signature-next") return this.advanceSignature(value);
        if (this.signature) throw new Error("Complete the signature scan before another operation.");
        if (value.operation === "project-query-next") return this.advanceQuery(value);
        if (this.query) throw new Error("Complete the query before mutating documents.");
        if (value.operation === "project-open" || value.operation === "project-change") {
            if (this.stage || !identity(value.document) || !integer(value.revision) || !integer(value.length)) throw new Error("Invalid document transfer.");
            const old = this.documents.get(value.document), opening = value.operation === "project-open";
            if (opening ? old || this.documents.size >= navigationLimits.documents : !old || old.revision !== value.previousRevision || value.revision <= old.revision) throw new Error("Invalid captured document revision.");
            const from = opening ? 0 : value.from, to = opening ? 0 : value.to, units = opening ? value.length : value.units, length = old?.buffer.length ?? 0;
            if (!integer(from) || !integer(to) || to < from || to > length || !integer(units) || units > navigationLimits.sourceUnits || value.length !== length - (to - from) + units || this.units - length + value.length > navigationLimits.sourceUnits) throw new Error("Invalid bounded document change.");
            this.stage = { document: value.document, revision: value.revision, length: value.length, units, from, received: 0, buffer: (old?.buffer ?? TextBuffer.from("")).replace(from, to, "") };
            return ack(opening ? "open" : "change", value.document, value.revision, value.length, 0);
        }
        if (value.operation === "project-chunk") {
            const stage = this.stage;
            if (!stage || value.document !== stage.document || value.revision !== stage.revision || value.from !== stage.received || typeof value.text !== "string" || !value.text.length || value.text.length > navigationLimits.chunkUnits || value.text.length > stage.units - stage.received) throw new Error("Invalid document chunk.");
            stage.buffer = stage.buffer.replace(stage.from + stage.received, stage.from + stage.received, value.text); stage.received += value.text.length;
            return ack("chunk", stage.document, stage.revision, stage.length, stage.received);
        }
        if (value.operation === "project-commit") {
            const stage = this.stage;
            if (!stage || value.document !== stage.document || value.revision !== stage.revision || stage.received !== stage.units || stage.buffer.length !== stage.length) throw new Error("Incomplete document transfer.");
            this.units += stage.length - (this.documents.get(stage.document)?.buffer.length ?? 0); this.documents.set(stage.document, Object.freeze({ revision: stage.revision, buffer: stage.buffer })); this.stage = undefined;
            return ack("commit", stage.document, stage.revision, stage.length, stage.received);
        }
        if (this.stage) throw new Error("Complete the document transfer before another operation.");
        if (value.operation === "project-signature") {
            const input = validateSignatureInput(value.input), doc = this.documents.get(input.document);
            if (!doc || doc.revision !== input.revision || doc.buffer.length !== input.length) throw new Error("Signature document is not synchronized.");
            this.signature = { input, buffer: doc.buffer, scanner: new SignatureScanner(), from: 0 };
            return { operation: "project-signature-progress", request: input.id, work: 0 };
        }
        if (value.operation === "project-command") {
            const input = validateProjectCommand(value.input);
            if (input.id <= this.lastCommand) throw new Error("Duplicate project command.");
            const documents = input.documents.map(doc => { const current = this.documents.get(doc.document);
                if (!current || current.revision !== doc.revision || current.buffer.length !== doc.length) throw new Error("Command document is not synchronized."); return current; });
            if (input.kind === "register" ? this.registered : input.kind !== "status" && !this.registered) throw new Error("Capability registration is not current.");
            this.lastCommand = input.id;
            if (input.kind === "status") return { operation: "project-command-result", request: input.id, applied: true, reason: `Provider has ${documents.length} synchronized working resources.`, registered: this.registered };
            const method = input.kind === "review" ? "edit" : input.kind;
            const edits = method === "edit" ? input.documents.flatMap((doc, i) => {
                const buffer = documents[i]!.buffer;
                if (buffer.slice(0, Math.min(buffer.length, reviewHeader.length)) === reviewHeader && buffer.slice(Math.max(0, buffer.length - reviewFooter.length), buffer.length) === reviewFooter) return [];
                return [{ document: doc.document, revision: doc.revision, edits: buffer.length ? [{ from: 0, to: 0, insert: reviewHeader }, { from: buffer.length, to: buffer.length, insert: reviewFooter }]
                    : [{ from: 0, to: 0, insert: reviewHeader + reviewFooter }] }];
            }) : [];
            this.command = { input, method };
            return { operation: "project-server-request", request: input.id, method, capability: reviewCapability, edits };
        }
        if (value.operation === "project-close") {
            if (!identity(value.document)) throw new Error("Invalid document close."); const old = this.documents.get(value.document);
            if (!old || old.revision !== value.revision) throw new Error("Invalid document close revision.");
            this.documents.delete(value.document); this.units -= old.buffer.length; return ack("close", value.document, old.revision, 0, 0);
        }
        if (value.operation === "project-query") {
            const input = validateNavigationInput(value.input), documents = input.documents.map(doc => {
                const current = this.documents.get(doc.document); if (!current || current.revision !== doc.revision || current.buffer.length !== doc.length) throw new Error("Query document is not synchronized."); return current;
            });
            this.query = { input, session: new NavigationSession(input), documents, ordinal: 0, from: 0, started: false, work: 0 };
            return { operation: "project-query-progress", request: input.id, work: 0 };
        }
        throw new Error("Unknown provider operation.");
    }
    private advanceQuery(value: Record<string, unknown>): Readonly<{ operation: string; [key: string]: unknown }> {
        const q = this.query; if (!q || value.request !== q.input.id) throw new Error("Invalid query continuation.");
        const doc = q.input.documents[q.ordinal];
        if (!doc) { const result = q.session.handle({ operation: "navigation-finish", id: q.input.id }); this.query = undefined; return { operation: "project-query-result", request: q.input.id, result }; }
        if (!q.started) { q.session.handle({ operation: "navigation-document", id: q.input.id, document: doc.document }); q.started = true; }
        const buffer = q.documents[q.ordinal]!.buffer;
        if (q.from < buffer.length) {
            const text = buffer.slice(q.from, Math.min(buffer.length, q.from + navigationLimits.chunkUnits));
            q.session.handle({ operation: "navigation-chunk", id: q.input.id, document: doc.document, from: q.from, text }); q.from += text.length; q.work += text.length;
        }
        if (q.from === buffer.length) { q.session.handle({ operation: "navigation-end-document", id: q.input.id, document: doc.document }); q.ordinal++; q.from = 0; q.started = false; }
        return { operation: "project-query-progress", request: q.input.id, work: q.work };
    }
    private advanceSignature(value: Record<string, unknown>): Readonly<{ operation: string; [key: string]: unknown }> {
        const q = this.signature; if (!q || value.request !== q.input.id) throw new Error("Invalid signature continuation.");
        if (q.from === q.input.offset) { const result = q.scanner.result(q.input); this.signature = undefined; return { operation: "project-signature-result", request: q.input.id, result }; }
        const text = q.buffer.slice(q.from, Math.min(q.input.offset, q.from + navigationLimits.chunkUnits)); q.scanner.feed(text, q.from); q.from += text.length;
        return { operation: "project-signature-progress", request: q.input.id, work: q.from };
    }
    buffer(document: string): TextBuffer | undefined { return this.documents.get(document)?.buffer; }
    snapshot() { return Object.freeze({ version: projectProtocolVersion, epoch: this.epoch, sequence: this.sequence, units: this.units, staging: !!this.stage, querying: !!this.query,
        registered: this.registered, serverPending: !!this.command, signaturePending: !!this.signature,
        documents: Object.freeze([...this.documents].map(([document, value]) => Object.freeze({ document, revision: value.revision, length: value.buffer.length }))) }); }
}
