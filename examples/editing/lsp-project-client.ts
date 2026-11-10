import type { DocumentId, Workspace } from "../../src/index.ts";
import { LspSession, RpcError } from "../../src/protocol/index.ts";
import type { LspDocument, LspSessionOptions } from "../../src/protocol/index.ts";
import type { ProjectCommand } from "../probes/project-commands.ts";
import { createLspCommandRunner } from "./lsp-command-runner.ts";
import type { LspCommandScope } from "./lsp-command-runner.ts";

export type LspProjectScope = LspCommandScope;
export type LspProjectOptions = Readonly<{ connect: LspSessionOptions["connect"]; uri: (id: DocumentId) => string; reviewCommand: string; statusCommand: string;
    beforeRequest?: (session: LspSession, input: ProjectCommand) => Promise<unknown> }>;
export type LspProjectClient = ReturnType<typeof createLspProjectClient>;
export type LspProjectFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspProjectClient;

/** One explicit command scope; incoming edit requests can only enter that scope's captured review. */
export function createLspProjectClient(workspace: Workspace, clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspProjectOptions) {
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false;
    let created = 0, terminated = 0;
    const changed = () => { for (const listener of [...listeners]) listener(); };
    const session = new LspSession({ features: ["workspace/executeCommand"], applyEdit: true,
        schedule: (ms, callback) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); }, connect: async context => {
            const transport = await options.connect(context); created++; let released = false;
            return { send: transport.send, subscribe: transport.subscribe, dispose: () => { if (released) return; released = true; terminated++; transport.dispose(); } };
        } });
    const runner = createLspCommandRunner(workspace, session, documents, options.uri, changed);
    return Object.freeze({ subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (input: ProjectCommand, scope: LspProjectScope) => {
            if (disposed || busy) throw new Error("Workspace provider is unavailable."); busy = true;
            try {
                await session.connect(); if (!scope.isCurrent()) throw new RpcError(-32801, "Captured project changed."); await runner.sync(scope);
                if (options.beforeRequest) await options.beforeRequest(session, input); if (!scope.isCurrent()) throw new RpcError(-32801, "Captured project changed.");
                if (input.kind === "register" || input.kind === "unregister") { const registered = session.commandNames().includes(options.reviewCommand); return Object.freeze({ registered, applied: registered === (input.kind === "register"), reason: registered ? "Provider review command registered for this connection." : "Provider review command is not registered." }); }
                const receipt = await runner.run(input.kind === "review" ? options.reviewCommand : options.statusCommand, [], scope, input.kind === "review");
                const result = input.kind === "status" ? { applied: true, reason: "Provider workspace status received." } : receipt.decision ?? { applied: false, failureReason: "Provider returned without requesting an edit decision." };
                return Object.freeze({ registered: session.commandNames().includes(options.reviewCommand), applied: result.applied,
                    reason: "reason" in result ? result.reason : result.applied ? "Captured provider edit decision acknowledged." : result.failureReason ?? "Provider edits declined." });
            } finally { busy = false; changed(); }
        },
        isCurrent: () => !disposed && runner.isCurrent(),
        faultIdle: () => { if (disposed || busy || session.state.getSnapshot().phase !== "ready") return false; session.disconnect(); return true; },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", epoch: session.state.getSnapshot().epoch, registered: session.commandNames().includes(options.reviewCommand), created, terminated, ...runner.snapshot(), protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; runner.dispose(); listeners.clear(); session.dispose(); documents.clear(); } });
}
