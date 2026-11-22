import { createLspColorClient } from "../../../src/protocol/index.ts";
import type { LspDocumentColor, LspPrepare, LspWorkspace } from "../../../src/protocol/index.ts";
import type { DocumentId, Workspace } from "../../../src/index.ts";
import type { ColorBackend } from "../../hosts/document-colors.ts";
import { rgbaColor } from "../../../fixtures/language/colors.ts";
import type { ColorPresentationInput, ColorReference, ColorsInput } from "../../../fixtures/language/colors.ts";

/** Host presentation models with optional, host-owned request preparation. */
export function lspColorBackend(workspace: Workspace, provider: LspWorkspace, changed: () => void,
    prepare?: Readonly<{ discovery: (input: ColorsInput) => LspPrepare; presentation: (input: ColorPresentationInput) => LspPrepare }>): ColorBackend {
    const client = createLspColorClient(provider), raw = new Map<ColorReference, LspDocumentColor>();
    let batch: Awaited<ReturnType<typeof client.run>> | undefined, busy = false, disposed = false, serial = 0;
    const stop = client.subscribe(() => queueMicrotask(() => { if (!disposed) changed(); }));
    return Object.freeze({
        colors: async (input, buffer) => {
            const token = ++serial, doc = workspace.document(input.document as DocumentId); busy = true; batch = undefined; raw.clear();
            try {
                if (doc.revision !== input.revision || doc.buffer !== buffer) throw new Error("Color fixture capture changed.");
                const result = await client.run(doc, prepare?.discovery(input));
                if (disposed || token !== serial || !result.isCurrent()) throw new Error("Color fixture result expired."); batch = result;
                const colors = result.items.map(item => { const value = Object.freeze({ from: item.from, to: item.to, color: item.color, label: rgbaColor(item.color), text: buffer.slice(item.from, Math.min(item.to, item.from + 96)) }); raw.set(value, item); return value; });
                return Object.freeze({ operation: "colors-result", id: input.id, document: input.document, revision: input.revision, complete: true, truncated: false, colors: Object.freeze(colors) });
            } finally { if (token === serial) { busy = false; changed(); } }
        },
        colorPresentations: async (input, buffer) => {
            const doc = workspace.document(input.document as DocumentId), item = raw.get(input.reference), captured = batch, token = serial;
            if (!captured || !item || doc.revision !== input.revision || doc.buffer !== buffer || !captured.isCurrent()) throw new Error("Discover a fresh captured provider color."); busy = true;
            try {
                const choices = await captured.presentations(item, input.proposed, prepare?.presentation(input));
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
