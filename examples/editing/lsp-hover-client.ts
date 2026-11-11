import { RpcError, decodeLspHover } from "../../src/protocol/index.ts";
import type { LspCall, LspDocument, LspDocumentCapture, LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { HoverBackend } from "./hover-backend.ts";
import type { HoverInput } from "../probes/hover.ts";
export type LspHoverOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: Pick<HoverInput, "delay" | "fault">) => Promise<unknown> }>;

export function createLspHoverClient(_clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspHoverOptions): HoverBackend {
    let binding: LspDocument | undefined, serial = 0, disposed = false;
    const session = options.provider.createScope();
    return Object.freeze({ subscribe: listener => session.state.subscribe(listener), snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", created: 0, transport: "lsp3.17", shared: true }),
        run: (document, offset, configuration) => {
            if (disposed) throw new Error("LSP hover client is disposed."); const token = ++serial; let wire: LspCall<unknown> | undefined, active = true;
            const current = () => { if (disposed || token !== serial || !active) throw new RpcError(-32800, "LSP hover cancelled."); };
            const result = (async () => {
                const previous = binding?.getSnapshot();
                if (previous && (previous.resourceId !== document.resourceId || previous.documentId !== document.id)) { binding!.close(); binding = undefined; }
                binding ??= session.attachDocument(document.id);
                if (binding.getSnapshot().revision !== document.revision || binding.getSnapshot().buffer !== document.buffer) throw new Error("A hover revision cannot name different buffers.");
                await session.connect(); current(); if (options.beforeRequest) await options.beforeRequest(session, configuration); current();
                let capture: LspDocumentCapture | undefined;
                wire = session.requestDocument("textDocument/hover", binding, (index, _snapshot, captured) => { capture = captured; return { position: index.at(offset) }; });
                const response = await wire.result; current(); const decoded = decodeLspHover(response, capture!);
                return decoded && Object.freeze({ revision: document.revision, range: decoded.range, text: decoded.text, isCurrent: capture!.isCurrent });
            })().finally(() => { active = false; });
            return Object.freeze({ result, cancel: () => { if (!active || token !== serial) return; active = false; serial++; wire?.cancel(); if (!wire) session.disconnect(); } });
        },
        disconnect: () => { if (disposed) return; serial++; session.disconnect(); },
        dispose: () => { if (disposed) return; disposed = true; serial++; session.dispose(); binding = undefined; } });
}
