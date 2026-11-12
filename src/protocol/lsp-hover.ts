import { createLspClient } from "./lsp-client.ts";
import { decodeLspHover } from "./lsp-features.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

export function createLspHoverClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ state: client.state, subscribe: client.subscribe, snapshot: client.snapshot, cancel: client.cancel, dispose: client.dispose,
        run: (document: DocumentSnapshot, offset: number, prepare?: LspPrepare) => {
            const call = client.request([document], document.id, "textDocument/hover", capture => ({ position: capture.index.at(offset) }), prepare);
            return Object.freeze({ cancel: call.cancel, result: call.result.then(value => value.decode(() => {
                const decoded = decodeLspHover(value.response, value.capture);
                return decoded && Object.freeze({ revision: document.revision, ...decoded, isCurrent: value.isCurrent });
            })) });
        } });
}
