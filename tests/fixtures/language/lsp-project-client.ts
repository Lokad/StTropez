import type { LspCommandScope, LspScopeAccess, LspWorkspace } from "../../../src/protocol/index.ts";
import type { ProjectCommand } from "./project-commands.ts";
import { createLspCommandRunner } from "../../../src/protocol/index.ts";

export type LspProjectOptions = Readonly<{ provider: LspWorkspace; reviewCommand: string; statusCommand: string;
    beforeRequest?: (session: LspScopeAccess, input: ProjectCommand) => Promise<unknown> }>;
export type LspProjectClient = ReturnType<typeof createLspProjectClient>;
export type LspProjectFactory = (changed: () => void) => LspProjectClient;

/** One explicit command scope; incoming edit requests can only enter that scope's captured review. */
export function createLspProjectClient(options: LspProjectOptions, onChange?: () => void) {
    let disposed = false, busy = false;
    const changed = () => { if (!disposed) onChange?.(); };
    const session = options.provider.createScope();
    const runner = createLspCommandRunner(session, changed);
    return Object.freeze({
        reviewCommand: options.reviewCommand,
        run: async (input: ProjectCommand, scope: LspCommandScope) => {
            if (input.kind === "review") throw new Error("Run reviews from their originating editor.");
            if (disposed || busy) throw new Error("Workspace provider is unavailable."); busy = true;
            try {
                await session.ensureConnected();
                const prepare = options.beforeRequest;
                await runner.sync(scope, prepare && (connection => prepare(connection, input)));
                if (input.kind === "register" || input.kind === "unregister") { const registered = session.commandNames().includes(options.reviewCommand); return Object.freeze({ registered, applied: registered === (input.kind === "register"), reason: registered ? "Provider review command registered for this connection." : "Provider review command is not registered." }); }
                await runner.run(options.statusCommand, [], scope, false);
                return { registered: session.commandNames().includes(options.reviewCommand), applied: true,
                    reason: "Provider workspace status received." };
            } finally { busy = false; changed(); }
        },
        isCurrent: () => !disposed && runner.isCurrent(),
        faultIdle: () => { if (disposed || busy || session.getSnapshot().phase !== "ready") return false; options.provider.disconnect(); return true; },
        snapshot: () => Object.freeze({ connected: session.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", epoch: session.getSnapshot().epoch, registered: session.commandNames().includes(options.reviewCommand), ...runner.snapshot(), protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; runner.dispose(); session.dispose(); } });
}
