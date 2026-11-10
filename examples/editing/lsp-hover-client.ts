import type { DocumentSnapshot } from "../../src/index.ts";
import { LspSession, RpcError, decodeLspHover } from "../../src/protocol/index.ts";
import type { LspCall, LspDocument, LspDocumentCapture, LspSessionOptions } from "../../src/protocol/index.ts";
import type { HoverBackend } from "./hover-backend.ts";
import type { HoverInput } from "../probes/hover.ts";
export type LspHoverOptions = Readonly<{ connect: LspSessionOptions["connect"]; uri: (document: DocumentSnapshot) => string;
    beforeRequest?: (session: LspSession, configuration: Pick<HoverInput, "delay" | "fault">) => Promise<unknown> }>;

export function createLspHoverClient(clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspHoverOptions): HoverBackend {
    let binding: LspDocument | undefined, serial = 0, created = 0, disposed = false;
    const session = new LspSession({ features: ["textDocument/hover"], schedule: (ms, callback) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); },
        connect: async context => { const transport = await options.connect(context); created++; return transport; } });
    return Object.freeze({ subscribe: listener => session.state.subscribe(listener), snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", created, transport: "lsp3.17" }),
        run: (document, offset, configuration) => {
            if (disposed) throw new Error("LSP hover client is disposed."); const token = ++serial; let wire: LspCall<unknown> | undefined, active = true;
            const current = () => { if (disposed || token !== serial || !active) throw new RpcError(-32800, "LSP hover cancelled."); };
            const result = (async () => {
                const uri = options.uri(document), previous = binding?.getSnapshot();
                if (previous && (previous.uri !== uri || previous.resourceId !== document.resourceId || previous.documentId !== document.id)) { binding!.close(); binding = undefined; }
                if (!binding) binding = session.bindDocument({ uri, languageId: "fixture", resourceId: document.resourceId, documentId: document.id, revision: document.revision, buffer: document.buffer });
                else if (binding.getSnapshot().revision !== document.revision) binding.update(binding.getSnapshot().revision, document.revision, document.buffer);
                else if (binding.getSnapshot().buffer !== document.buffer) throw new Error("A hover revision cannot name different buffers.");
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
