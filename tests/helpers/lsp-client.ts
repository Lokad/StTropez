import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { referencePeer } from "../fixtures/protocol/reference-peer.ts";
import type { LspTargetResolver, LspWorkspaceOptions, RpcTransport } from "../../src/protocol/index.ts";

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
    type Listener = Parameters<RpcTransport["subscribe"]>[0];
    const listeners: (Listener | undefined)[] = [], packets: { sender: number; method?: string; params?: unknown }[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>(), errors: string[] = [];
    let closed = false;
    const ports = [0, 1].map(index => ({
        send: (text: string) => {
            if (closed) throw new Error("Closed transport");
            packets.push({ sender: index, ...JSON.parse(text) });
            queueMicrotask(() => { if (!closed) listeners[1 - index]?.message(text); });
        },
        subscribe: (listener: Listener) => { listeners[index] = listener; return () => { if (listeners[index] === listener) listeners[index] = undefined; }; },
        dispose: () => { if (closed) return; closed = true; for (const listener of listeners) listener?.close(new Error("Closed")); listeners.fill(undefined); }
    }));
    const peer = referencePeer(ports[1]!);
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
        connect: async () => { await connect?.(); return ports[0]!; },
        schedule: (ms, callback) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; },
        ...options,
        onError: error => errors.push(error.message)
    });
    t.after(async () => {
        provider.dispose(); await settled(); peer.dispose(); ports[0]!.dispose();
        for (const timer of timers) clearTimeout(timer);
        assert.deepEqual(errors, []);
    });
    const document = () => workspace.document(source.id);
    return { workspace, source, other, provider, peer, document, errors,
        sent: (method: string) => packets.filter(packet => packet.sender === 0 && packet.method === method),
        edit: () => { const doc = document(); return workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from: 0, to: 0, insert: "prefix " }], origin: "human" }); }
    };
}
