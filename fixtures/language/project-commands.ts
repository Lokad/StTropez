import { validateTextEdits } from "../../src/index.ts";
import type { TextEdit } from "../../src/index.ts";
import { validateNavigationDocuments } from "./navigation.ts";
import type { NavigationDocument } from "./navigation.ts";
export const reviewHeader = "// provider review\r\n", reviewFooter = "\r\n// end provider review";
export type ProjectCommandKind = "register" | "unregister" | "review" | "status";
export type ProjectCommand = Readonly<{ kind: ProjectCommandKind; documents: readonly NavigationDocument[]; delay: number; fault?: "malformed" | "failure" | "ack" }>;
export type ServerEdit = Readonly<{ document: string; revision: number; edits: readonly TextEdit[] }>;
export type ProjectOutcome = Readonly<{ applied: boolean; reason: string }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
export function validateProjectCommand(v: unknown): ProjectCommand {
    if (!record(v) || !["register", "unregister", "review", "status"].includes(v.kind as string)
        || typeof v.delay !== "number" || !Number.isFinite(v.delay) || v.delay < 0 || v.delay > 1000 || v.fault !== undefined && !["malformed", "failure", "ack"].includes(v.fault as string)) throw new Error("Invalid project command.");
    return Object.freeze({ kind: v.kind as ProjectCommandKind, documents: validateNavigationDocuments(v.documents), delay: v.delay, ...(v.fault === undefined ? {} : { fault: v.fault as NonNullable<ProjectCommand["fault"]> }) });
}
/** Validate the entire untrusted server batch before a host is allowed to mutate anything. */
export function validateProjectEdits(value: unknown, documents: readonly NavigationDocument[]): readonly ServerEdit[] {
    if (!Array.isArray(value) || value.length > documents.length) throw new Error("Invalid edit targets.");
    const ids = new Set<string>(); let count = 0, units = 0;
    const edits = value.map((raw: unknown): ServerEdit => {
        if (!record(raw) || typeof raw.document !== "string" || ids.has(raw.document) || !Array.isArray(raw.edits) || !raw.edits.length) throw new Error("Invalid server edit target.");
        const doc = documents.find(d => d.document === raw.document); if (!doc || raw.revision !== doc.revision) throw new Error("Stale server edit revision."); ids.add(raw.document);
        const changes = raw.edits.map((edit: unknown): TextEdit => {
            if (!record(edit) || typeof edit.from !== "number" || typeof edit.to !== "number" || typeof edit.insert !== "string" || ++count > 256 || (units += edit.insert.length) > 16384) throw new Error("Server edit batch exceeds bounds.");
            return Object.freeze({ from: edit.from, to: edit.to, insert: edit.insert });
        });
        validateTextEdits(doc.length, changes); return Object.freeze({ document: raw.document, revision: doc.revision, edits: Object.freeze(changes) });
    });
    return Object.freeze(edits);
}
