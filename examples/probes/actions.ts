import { DomainCursor, validDomainModule, validateDomainResult } from "./domain.ts";
import type { DomainInput } from "./domain.ts";
import { validateNavigationDocuments } from "./navigation.ts";
import { validateProjectEdits } from "./project-commands.ts";
import type { ServerEdit } from "./project-commands.ts";
import type { TextBuffer } from "../../src/index.ts";
export type ActionInput = Readonly<{ operation: "action-start"; id: number; document: string; revision: number; length: number; from: number; to: number; module: string; delay: number; fault?: "malformed" | "failure" | "incomplete" | "markup" }>;
export type ModuleAction = Readonly<{ id: "module-import"; kind: "source.addImport"; title: string; disabled: string | null; edits: readonly ServerEdit[] }>;
export type ActionResult = Readonly<{ operation: "action-result"; id: number; document: string; revision: number; module: string; from: number; to: number; complete: true; action: ModuleAction }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validateActionInput(v: unknown): ActionInput {
    if (!record(v) || v.operation !== "action-start" || !integer(v.id) || !v.id || !integer(v.from) || !integer(v.to) || v.to < v.from || !integer(v.length) || v.to > v.length
        || typeof v.module !== "string" || !validDomainModule(v.module) || typeof v.delay !== "number" || !Number.isFinite(v.delay) || v.delay < 0 || v.delay > 1000
        || v.fault !== undefined && !["malformed", "failure", "incomplete", "markup"].includes(v.fault as string)) throw new Error("Invalid captured module action.");
    const [doc] = validateNavigationDocuments([{ document: v.document, revision: v.revision, length: v.length }]);
    return Object.freeze({ operation: "action-start", id: v.id, ...doc!, from: v.from, to: v.to, module: v.module, delay: v.delay, ...(v.fault === undefined ? {} : { fault: v.fault as NonNullable<ActionInput["fault"]> }) });
}
/** One existing domain scan per captured action, in bounded resident-worker continuations. */
export class ModuleActionCursor {
    private readonly input: ActionInput;
    private readonly domain: DomainInput;
    private readonly cursor: DomainCursor;
    constructor(capture: unknown, buffer: TextBuffer) {
        this.input = validateActionInput(capture); if (buffer.length !== this.input.length) throw new Error("Missing captured action buffer.");
        this.domain = { id: this.input.id, revision: this.input.revision, buffer, kind: "import", module: this.input.module }; this.cursor = new DomainCursor(this.domain);
    }
    next(): Readonly<{ work: number; result?: ActionResult }> {
        const step = this.cursor.next(16384); if (step.status !== "done") return { work: step.work };
        const input = this.input, result = validateDomainResult(step.result, this.domain), edits = result.edits.length ? [{ document: input.document, revision: input.revision, edits: result.edits }] : [];
        return { work: step.work, result: validateActionResult({ operation: "action-result", id: input.id, document: input.document, revision: input.revision, module: input.module, from: input.from, to: input.to, complete: true,
            action: { id: "module-import", kind: "source.addImport", title: `Insert module ${JSON.stringify(input.module)}`, disabled: edits.length ? null : "The requested import is already present.", edits } }, input) };
    }
}
export function validateActionResult(v: unknown, input: ActionInput): ActionResult {
    if (!record(v) || v.operation !== "action-result" || v.id !== input.id || v.document !== input.document || v.revision !== input.revision || v.module !== input.module || v.from !== input.from || v.to !== input.to || v.complete !== true
        || !record(v.action) || v.action.id !== "module-import" || v.action.kind !== "source.addImport" || typeof v.action.title !== "string" || !v.action.title.length || v.action.title.length > 256
        || v.action.disabled !== null && (typeof v.action.disabled !== "string" || !v.action.disabled.length || v.action.disabled.length > 256)) throw new Error("Invalid or incomplete captured action.");
    const edits = validateProjectEdits(v.action.edits, [{ document: input.document, revision: input.revision, length: input.length }]);
    if (v.action.disabled !== null && edits.length || v.action.disabled === null && !edits.length) throw new Error("Invalid action availability.");
    return Object.freeze({ operation: "action-result", id: input.id, document: input.document, revision: input.revision, module: input.module, from: input.from, to: input.to, complete: true,
        action: Object.freeze({ id: "module-import", kind: "source.addImport", title: v.action.title, disabled: v.action.disabled, edits }) });
}
