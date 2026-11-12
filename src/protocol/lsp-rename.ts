import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspClient } from "./lsp-client.ts";
import { decodeLspWorkspaceEdit } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** A rename response is a fixed provider edit batch for one captured new name. */
export function createLspRenameClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ state: client.state, subscribe: client.subscribe, cancel: client.cancel, dispose: client.dispose,
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, prepare?: LspPrepare) => {
            const value = await client.request(snapshots, origin, "textDocument/rename", capture => ({ position: capture.index.at(offset), newName }), prepare).result;
            const plan = value.decode(() => decodeLspWorkspaceEdit(value.response === null ? {} : value.response, uri => value.captures.get(uri)));
            return Object.freeze({ ...plan, isCurrent: value.isCurrent });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), busy: client.isBusy(), version: "LSP3.17" }) });
}
