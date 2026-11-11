import { RpcError } from "./json-rpc.ts";
import { decodeLspHover } from "./lsp-features.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { LspCall, LspDocument, LspDocumentCapture } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
export function createLspHoverClient(provider: LspWorkspace) {
    let binding: LspDocument | undefined, serial = 0, disposed = false;
    const session = provider.createScope();
    return Object.freeze({ state: provider.state, subscribe: (listener: () => void) => session.state.subscribe(listener), snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", disposed, protocol: session.snapshotOwnership() }),
        run: (document: DocumentSnapshot, offset: number, prepare?: LspPrepare) => {
            if (disposed) throw new Error("LSP hover client is disposed."); const token = ++serial; let wire: LspCall<unknown> | undefined, active = true;
            const current = () => { if (disposed || token !== serial || !active) throw new RpcError(-32800, "LSP hover cancelled."); };
            const result = (async () => {
                const previous = binding?.getSnapshot();
                if (previous && (previous.resourceId !== document.resourceId || previous.documentId !== document.id)) { binding!.close(); binding = undefined; }
                binding ??= session.attachDocument(document.id);
                await session.connect(); current();
                if (binding.getSnapshot().revision !== document.revision || binding.getSnapshot().buffer !== document.buffer) throw new Error("A hover revision cannot name different buffers.");
                if (prepare) await prepare(session); current();
                let capture: LspDocumentCapture | undefined;
                wire = session.requestDocument("textDocument/hover", binding, (index, _snapshot, captured) => { capture = captured; return { position: index.at(offset) }; });
                const response = await wire.result; current(); const decoded = decodeLspHover(response, capture!);
                return decoded && Object.freeze({ revision: document.revision, range: decoded.range, text: decoded.text, isCurrent: capture!.isCurrent });
            })().finally(() => { active = false; });
            return Object.freeze({ result, cancel: () => { if (!active || token !== serial) return; active = false; serial++; wire?.cancel(); if (!wire) session.disconnect(); } });
        },
        cancel: () => { if (disposed) return; serial++; session.disconnect(); },
        dispose: () => { if (disposed) return; disposed = true; serial++; session.dispose(); binding = undefined; } });
}
