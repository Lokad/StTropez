import type { TextBuffer } from "../../src/index.ts";
import { DomainCursor, validDomainModule } from "./domain.ts";
import { navigationLimits, validateNavigationDocuments } from "./navigation.ts";
export const linkLimits = Object.freeze({ aliases: 100, links: 1024, page: 64 });
export type LinkTarget = Readonly<{ resource: string; document: string; revision: number; length: number }>;
export type LinkAlias = LinkTarget & Readonly<{ module: string }>;
export type LinksInput = LinkTarget & Readonly<{ id: number; aliases: readonly LinkAlias[]; delay: number; fault?: "malformed" | "failure" | "incomplete" | "markup" }>;
export type ModuleLink = Readonly<{ from: number; to: number; module: string; tooltip: string; target: LinkTarget | null }>;
export type LinksResult = Readonly<{ operation: "links-result"; id: number; document: string; revision: number; complete: true; truncated: boolean; links: readonly ModuleLink[] }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validateLinksInput(v: unknown): LinksInput {
    if (!record(v) || !integer(v.id) || !v.id || !identity(v.resource) || !Array.isArray(v.aliases) || v.aliases.length > linkLimits.aliases
        || typeof v.delay !== "number" || !Number.isFinite(v.delay) || v.delay < 0 || v.delay > 1000 || v.fault !== undefined && !["malformed", "failure", "incomplete", "markup"].includes(v.fault as string)) throw new Error("Invalid captured document links.");
    const [source] = validateNavigationDocuments([{ document: v.document, revision: v.revision, length: v.length }]), modules = new Set<string>(), documents = new Map<string, LinkTarget>([[source!.document, { ...source!, resource: v.resource }]]);
    const aliases = v.aliases.map((a: unknown): LinkAlias => {
        if (!record(a) || typeof a.module !== "string" || !validDomainModule(a.module) || modules.has(a.module) || !identity(a.resource)) throw new Error("Invalid host module alias.");
        const [doc] = validateNavigationDocuments([{ document: a.document, revision: a.revision, length: a.length }]), old = documents.get(doc!.document);
        if (old && (old.resource !== a.resource || old.revision !== doc!.revision || old.length !== doc!.length)) throw new Error("Conflicting module resource identity.");
        const alias = Object.freeze({ module: a.module, resource: a.resource, ...doc! }); modules.add(a.module); documents.set(alias.document, alias); return alias;
    });
    validateNavigationDocuments([...documents.values()]);
    return Object.freeze({ id: v.id, resource: v.resource, ...source!, aliases: Object.freeze(aliases), delay: v.delay, ...(v.fault === undefined ? {} : { fault: v.fault as NonNullable<LinksInput["fault"]> }) });
}
/** Reuse the exact bounded import-line grammar; no general parser or module resolver. */
export class ModuleLinksCursor {
    private readonly input: LinksInput;
    private readonly cursor: DomainCursor;
    private readonly links: ModuleLink[] = [];
    private truncated = false;
    constructor(capture: unknown, buffer: TextBuffer) {
        const input = this.input = validateLinksInput(capture); if (buffer.length !== input.length) throw new Error("Missing captured link source.");
        const aliases = new Map(input.aliases.map(a => [a.module, a]));
        this.cursor = new DomainCursor({ id: input.id, revision: input.revision, buffer, kind: "import", module: "sample-utils" }, (from, to, module) => {
            if (this.links.length === linkLimits.links) { this.truncated = true; return; }
            const alias = aliases.get(module), target = alias ? Object.freeze({ resource: alias.resource, document: alias.document, revision: alias.revision, length: alias.length }) : null;
            this.links.push(Object.freeze({ from, to, module, tooltip: target ? `Open the captured ${module} resource` : `No host resource is registered for ${module}`, target }));
        });
    }
    next(): Readonly<{ work: number; result?: LinksResult }> {
        const step = this.cursor.next(navigationLimits.chunkUnits); if (step.status !== "done") return { work: step.work };
        return { work: step.work, result: Object.freeze({ operation: "links-result", id: this.input.id, document: this.input.document, revision: this.input.revision, complete: true, truncated: this.truncated, links: Object.freeze(this.links.slice()) }) };
    }
}
export function validateLinksResult(v: unknown, input: LinksInput, buffer: TextBuffer): LinksResult {
    if (buffer.length !== input.length || !record(v) || v.operation !== "links-result" || v.id !== input.id || v.document !== input.document || v.revision !== input.revision || v.complete !== true || typeof v.truncated !== "boolean"
        || !Array.isArray(v.links) || v.links.length > linkLimits.links) throw new Error("Invalid or incomplete document links.");
    if (v.truncated) throw new Error("Document links exceed 1,024 locations; narrow the source.");
    let end = -1;
    const links = v.links.map((raw: unknown): ModuleLink => {
        if (!record(raw) || !integer(raw.from) || !integer(raw.to) || raw.from < end || raw.to <= raw.from || raw.to > input.length || typeof raw.module !== "string" || !validDomainModule(raw.module)
            || raw.to - raw.from !== raw.module.length || typeof raw.tooltip !== "string" || !raw.tooltip.length || raw.tooltip.length > 256) throw new Error("Invalid document-link range or text.");
        const line = buffer.lineAt(raw.from), start = buffer.offsetAt(line), bom = start === 0 && buffer.slice(0, Math.min(1, buffer.length)) === "\ufeff" ? 1 : 0;
        let until = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        if (until && buffer.slice(until - 1, until) === "\n") until--; if (until && buffer.slice(until - 1, until) === "\r") until--;
        if (raw.from !== start + bom + 8 || raw.to + 2 !== until || buffer.slice(start + bom, raw.to + 2) !== `import "${raw.module}";`) throw new Error("Link does not cover an exact captured import line.");
        const alias = input.aliases.find(a => a.module === raw.module); let target: LinkTarget | null = null;
        if (alias) { if (!record(raw.target) || raw.target.resource !== alias.resource || raw.target.document !== alias.document || raw.target.revision !== alias.revision || raw.target.length !== alias.length) throw new Error("Unregistered or stale link target.");
            target = Object.freeze({ resource: alias.resource, document: alias.document, revision: alias.revision, length: alias.length });
        } else if (raw.target !== null) throw new Error("A link cannot execute an unregistered target.");
        end = raw.to; return Object.freeze({ from: raw.from, to: raw.to, module: raw.module, tooltip: raw.tooltip, target });
    });
    return Object.freeze({ operation: "links-result", id: input.id, document: input.document, revision: input.revision, complete: true, truncated: false, links: Object.freeze(links) });
}
