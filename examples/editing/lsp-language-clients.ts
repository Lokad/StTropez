import { createLspColorClient, createLspLinkClient, createLspSignatureClient } from "../../src/protocol/index.ts";
import type { LspDocumentColor, LspDocumentLink, LspPrepare, LspSignatureHelp, LspWorkspace } from "../../src/protocol/index.ts";
import type { DocumentId, Workspace } from "../../src/index.ts";
import type { SignatureBackend } from "../hosts/signature.ts";
import type { SignatureInput } from "../probes/signature.ts";
import type { HostModuleLink, LinkBackend } from "../hosts/document-links.ts";
import type { LinkTarget } from "../probes/links.ts";
import type { ColorBackend } from "../hosts/document-colors.ts";
import { rgbaColor } from "../probes/colors.ts";
import type { ColorReference } from "../probes/colors.ts";

/** Only fixture configuration and host presentation models live in these wrappers. */
export function lspSignatureBackend(workspace: Workspace, provider: LspWorkspace, changed: () => void, prepare?: (input: SignatureInput) => LspPrepare): SignatureBackend {
    const client = createLspSignatureClient(provider); let busy = false, disposed = false, result: (LspSignatureHelp & Readonly<{ isCurrent: () => boolean }>) | null = null, serial = 0;
    const stop = client.subscribe(changed);
    return Object.freeze({
        trigger: (document, character, retrigger) => client.options(document).some(option => [...Array.isArray(option.triggerCharacters) ? option.triggerCharacters : [], ...retrigger && Array.isArray(option.retriggerCharacters) ? option.retriggerCharacters : []].includes(character)),
        signature: async (input, buffer, _progress, context) => {
            const token = ++serial, previous = result, doc = workspace.document(input.document as DocumentId); result = null; busy = true;
            try {
                if (doc.revision !== input.revision || doc.buffer !== buffer) throw new Error("Signature capture changed.");
                const help = await client.run(doc, input.offset, { ...context ?? { triggerKind: 1, isRetrigger: false }, ...(context?.isRetrigger && previous ? { activeSignatureHelp: previous.wire } : {}) }, prepare?.(input)).result;
                if (disposed || token !== serial || help && !help.isCurrent()) throw new Error("Signature result expired."); result = help;
                return Object.freeze({ id: input.id, document: input.document, revision: input.revision, reason: help?.signatures.length ? "ready" as const : "no-call" as const,
                    call: null, signatures: help?.signatures ?? Object.freeze([]), activeSignature: help?.activeSignature ?? 0 });
            } finally { if (token === serial) { busy = false; changed(); } }
        },
        isCurrent: () => !disposed && (result?.isCurrent() ?? true), snapshot: () => Object.freeze({ connected: client.snapshot().connected, busy, transport: "lsp3.17" }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stop(); client.dispose(); } });
}
export function lspLinkBackend(workspace: Workspace, provider: LspWorkspace, uri: (id: DocumentId) => string, changed: () => void): LinkBackend {
    const client = createLspLinkClient(provider), raw = new Map<HostModuleLink, LspDocumentLink>();
    let batch: Awaited<ReturnType<typeof client.run>> | undefined, normalize: ((item: LspDocumentLink) => HostModuleLink) | undefined, busy = false, disposed = false, serial = 0;
    const stop = client.subscribe(changed);
    return Object.freeze({
        links: async (input, buffer) => {
            const token = ++serial, doc = workspace.document(input.document as DocumentId); busy = true; batch = undefined; raw.clear();
            try {
                if (doc.revision !== input.revision || doc.buffer !== buffer) throw new Error("Link fixture capture changed.");
                const targets = new Map<string, LinkTarget>([[uri(doc.id), { resource: input.resource, document: input.document, revision: input.revision, length: input.length }], ...input.aliases.map(target => [uri(target.document as DocumentId), target] as const)]);
                const result = await client.run(doc, session => session.request("fixture/linksConfig", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}), aliases: input.aliases.map(alias => ({ module: alias.module, uri: uri(alias.document as DocumentId) })) }).result);
                if (disposed || token !== serial || !result.isCurrent()) throw new Error("Link fixture result expired."); batch = result;
                normalize = item => { const target = item.target ? targets.get(item.target) ?? null : null;
                    const link = Object.freeze({ from: item.from, to: item.to, module: buffer.slice(item.from, Math.min(item.to, item.from + 128)), tooltip: item.tooltip || item.target || "Unresolved provider link", target, resolvable: !target && !!item.resolve }); raw.set(link, item); return link; };
                return Object.freeze({ operation: "links-result", id: input.id, document: input.document, revision: input.revision, complete: true, truncated: false, links: Object.freeze(result.items.map(normalize)) });
            } finally { if (token === serial) { busy = false; changed(); } }
        },
        resolve: async link => {
            const item = raw.get(link), captured = batch, token = serial; if (!captured || !item || !normalize || !captured.isCurrent()) throw new Error("Choose a captured resolvable provider link."); busy = true;
            try { const resolved = await captured.resolve(item); if (disposed || token !== serial || !captured.isCurrent()) throw new Error("Link resolution expired."); return normalize(resolved); }
            finally { if (token === serial) { busy = false; changed(); } }
        },
        isCurrent: () => !disposed && (batch?.isCurrent() ?? true), snapshot: () => Object.freeze({ connected: client.snapshot().connected, busy, transport: "lsp3.17" }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stop(); client.dispose(); raw.clear(); batch = undefined; normalize = undefined; } });
}
export function lspColorBackend(workspace: Workspace, provider: LspWorkspace, changed: () => void): ColorBackend {
    const client = createLspColorClient(provider), raw = new Map<ColorReference, LspDocumentColor>();
    let batch: Awaited<ReturnType<typeof client.run>> | undefined, busy = false, disposed = false, serial = 0; const stop = client.subscribe(changed);
    return Object.freeze({
        colors: async (input, buffer) => {
            const token = ++serial, doc = workspace.document(input.document as DocumentId); busy = true; batch = undefined; raw.clear();
            try {
                if (doc.revision !== input.revision || doc.buffer !== buffer) throw new Error("Color fixture capture changed.");
                const result = await client.run(doc, session => session.request("fixture/colorConfig", { kind: "discovery", delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }).result);
                if (disposed || token !== serial || !result.isCurrent()) throw new Error("Color fixture result expired."); batch = result;
                const colors = result.items.map(item => { const value = Object.freeze({ from: item.from, to: item.to, color: item.color, label: rgbaColor(item.color), text: buffer.slice(item.from, Math.min(item.to, item.from + 96)) }); raw.set(value, item); return value; });
                return Object.freeze({ operation: "colors-result", id: input.id, document: input.document, revision: input.revision, complete: true, truncated: false, colors: Object.freeze(colors) });
            } finally { if (token === serial) { busy = false; changed(); } }
        },
        colorPresentations: async (input, buffer) => {
            const doc = workspace.document(input.document as DocumentId), item = raw.get(input.reference), captured = batch, token = serial;
            if (!captured || !item || doc.revision !== input.revision || doc.buffer !== buffer || !captured.isCurrent()) throw new Error("Discover a fresh captured provider color."); busy = true;
            try {
                const choices = await captured.presentations(item, input.proposed, session => session.request("fixture/colorConfig", { kind: "presentation", delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }).result);
                if (disposed || token !== serial || !captured.isCurrent()) throw new Error("Color presentation expired.");
                return Object.freeze({ operation: "color-presentations-result", id: input.id, discovery: input.discovery, document: input.document, revision: input.revision,
                    from: input.reference.from, to: input.reference.to, proposed: input.proposed, complete: true,
                    presentations: Object.freeze(choices.map((choice, index) => Object.freeze({ id: `provider-${index}`, label: choice.label,
                        edits: Object.freeze([Object.freeze({ document: input.document, revision: input.revision, edits: choice.edits })]) }))) });
            } finally { if (token === serial) { busy = false; changed(); } }
        },
        isCurrent: () => !disposed && (batch?.isCurrent() ?? true), snapshot: () => Object.freeze({ connected: client.snapshot().connected, busy, transport: "lsp3.17" }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stop(); client.dispose(); raw.clear(); batch = undefined; } });
}
