import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { referencePeer } from "../fixtures/protocol/reference-peer.ts";
import type { LspTargetResolver, LspWorkspaceOptions } from "../../src/protocol/index.ts";

import { Workspace } from "../../src/index.ts";

import * as protocol from "../../src/protocol/index.ts";
export { protocol };
export const settled = async () => { await setImmediate(); await setImmediate(); };
export function clientFixture(t: TestContext, connect?: () => Promise<void>, resolveTarget?: LspTargetResolver,
    options?: Partial<Pick<LspWorkspaceOptions, "now" | "schedule" | "maxScopes" | "applyEdit">>) {
    const workspace = new Workspace();
    const source = workspace.createTextResource({ scope: "public-client", resource: "source", variant: "working" }, "Source", {
        value: "alpha beta",
        language: { uri: "generic:source", languageId: "generic" },
    });
    const other = workspace.createTextResource({ scope: "public-client", resource: "other", variant: "working" }, "Other", {
        value: "gamma delta",
        language: { uri: "generic:other", languageId: "generic" },
    });
    const packets: { method?: string; params?: unknown }[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>(), errors: string[] = [];
    const pair = protocol.createRpcTransportPair(queueMicrotask);
    const transport = { ...pair.client, send(frame: string) {
        packets.push(JSON.parse(frame));
        pair.client.send(frame);
    } };
    const peer = referencePeer(pair.server);
    peer.onRequest("initialize", () => ({ capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: true,
        completionProvider: { resolveProvider: true, allCommitCharacters: [";"] }, codeActionProvider: { resolveProvider: true }, foldingRangeProvider: true, documentHighlightProvider: true, signatureHelpProvider: {}, documentLinkProvider: { resolveProvider: true }, colorProvider: true, executeCommandProvider: { commands: ["fixture.command"] } } }));
    peer.onRequest("textDocument/hover", () => ({ contents: "captured hover" }));
    peer.onRequest("textDocument/definition", () => []);
    peer.onRequest("textDocument/rename", () => ({}));
    peer.onRequest("textDocument/codeAction", () => []);
    peer.onRequest("workspace/executeCommand", () => null);
    peer.listen();
    const provider = new protocol.LspWorkspace(workspace, {
        ...(resolveTarget ? { resolveTarget } : {}),
        applyEdit: true,
        connect: async () => { await connect?.(); return transport; },
        schedule: (ms, callback) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; },
        ...options,
        onError: error => errors.push(error.message)
    });
    t.after(async () => {
        provider.dispose(); await settled(); peer.dispose(); transport.dispose();
        for (const timer of timers) clearTimeout(timer);
        assert.deepEqual(errors, []);
    });
    const document = () => workspace.document(source.id);
    return { workspace, source, other, provider, peer, document, errors,
        sent: (method: string) => packets.filter(packet => packet.method === method),
        edit: () => { const doc = document(); return workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from: 0, to: 0, insert: "prefix " }], origin: "human" }); }
    };
}
