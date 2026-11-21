import { createCompletionController, createDiagnosticController } from "../../../src/browser/index.ts";
import type { DiagnosticController, TextEditor } from "../../../src/browser/index.ts";
import { HostCell } from "../observable.ts";
import type { LspScopeAccess, LspWorkspace } from "../../../src/protocol/index.ts";
import type { ProviderController, ProviderOptions } from "./provider-contract.ts";

export type LspProviderOptions = ProviderOptions & Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspScopeAccess, configuration: Readonly<{ delay: number; fault?: "malformed" | "failure" }>) => Promise<unknown> }>;

/** Development-only fault/delay controls around the same public editor integration. */
export function createLspProviderController(editor: TextEditor, options: LspProviderOptions): ProviderController {
    let delay = 0, fault: "malformed" | "failure" | undefined;
    const controller = createCompletionController(editor, options.provider, { ...options,
        prepareCompletion: async session => { const nextFault = fault; fault = undefined;
            await options.beforeRequest?.(session, { delay, ...(nextFault ? { fault: nextFault } : {}) }); } });
    let diagnostics: DiagnosticController;
    try { diagnostics = createDiagnosticController(editor, options.provider, options); }
    catch (error) { controller.dispose(); throw error; }
    const read = () => ({ ...controller.getSnapshot(), ...diagnostics.getSnapshot() });
    const cell = new HostCell(read()), update = () => cell.set(read());
    const stopCompletion = controller.subscribe(update), stopDiagnostics = diagnostics.subscribe(update);
    return Object.freeze({ ...controller, ...cell.observable,
        selectDiagnostic: (index: number) => diagnostics.getSnapshot().diagnostics[index]?.select() ?? false,
        disconnect: () => { controller.cancel(); options.provider.disconnect(); },
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid fixture delay."); delay = value; },
        faultNext: (value: "malformed" | "failure") => { fault = value; },
        snapshot: () => {
            const completion = controller.getDiagnostics(), counts = diagnostics.getDiagnostics(), state = diagnostics.getSnapshot();
            return Object.freeze({ ...completion, stale: completion.stale + counts.stale, invalid: completion.invalid + counts.invalid,
                diagnostics: state.diagnostics.length, diagnosticRevision: state.diagnosticRevision, diagnosticsPending: state.diagnosticsPending });
        },
        dispose: () => { stopCompletion(); stopDiagnostics(); controller.dispose(); diagnostics.dispose(); } });
}
