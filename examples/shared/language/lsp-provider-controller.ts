import { fixtureRequests, type FixturePolicy } from "./fixture-requests.ts";
import { attachEditorLanguage } from "../../../src/browser/index.ts";
import type { CompletionControllerOptions, TextEditor } from "../../../src/browser/index.ts";
import { HostCell } from "../observable.ts";
import type { LspScopeAccess, LspWorkspace } from "../../../src/protocol/index.ts";

type ProviderOptions = Pick<CompletionControllerOptions, "autoConnect" | "canCapture" | "getPageSize">;
export type LspProviderOptions = ProviderOptions & Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspScopeAccess, configuration: FixturePolicy<"malformed" | "failure">) => Promise<unknown> }>;
export type LspProviderController = ReturnType<typeof createLspProviderController>;
export type LspProviderFactory = (editor: TextEditor, options: ProviderOptions) => LspProviderController;

/** Development-only fault/delay controls around the same public editor integration. */
export function createLspProviderController(editor: TextEditor, options: LspProviderOptions) {
    const fixture = fixtureRequests<"malformed" | "failure">("fixture");
    const language = attachEditorLanguage(editor, options.provider, {
        diagnostics: options,
        completion: { ...options, prepareCompletion: async session => {
            const policy = fixture.take();
            await options.beforeRequest?.(session, policy);
        } },
    });
    const { completion: controller, diagnostics } = language;
    const read = () => ({ ...controller.getSnapshot(), ...diagnostics.getSnapshot() } as const);
    const cell = new HostCell(read()), update = () => cell.set(read());
    const stopCompletion = controller.subscribe(update), stopDiagnostics = diagnostics.subscribe(update);
    return Object.freeze({ ...controller, ...cell.observable,
        disconnect: () => { controller.cancel(); options.provider.disconnect(); },
        setDelay: fixture.setDelay, faultNext: fixture.faultNext,
        getDiagnostics: () => {
            const completion = controller.getDiagnostics(), counts = diagnostics.getDiagnostics(), state = diagnostics.getSnapshot();
            return Object.freeze({ ...completion, stale: completion.stale + counts.stale, invalid: completion.invalid + counts.invalid,
                diagnostics: state.diagnostics.length, diagnosticRevision: state.diagnosticRevision, diagnosticsPending: state.diagnosticsPending });
        },
        dispose: () => { stopCompletion(); stopDiagnostics(); language.dispose(); } });
}
