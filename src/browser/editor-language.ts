import { requireLanguageView } from "./captured-view.ts";
import { retainLspDocument } from "../protocol/lsp-client.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import { mountCompletion, type CompletionController, type CompletionControllerOptions } from "./completion-controller.ts";
import { mountDiagnostic, type DiagnosticController, type DiagnosticControllerOptions } from "./diagnostic-controller.ts";
import { mountHover, type HoverController, type HoverControllerOptions } from "./hover-controller.ts";
import type { TextEditor } from "./text-editor.ts";

type Options = { completion?: CompletionControllerOptions; diagnostics?: DiagnosticControllerOptions; hover?: HoverControllerOptions };
type Features = { completion: CompletionController; diagnostics: DiagnosticController; hover: HoverController };
type Attachment<O extends Options> = Readonly<{ [K in keyof O]: K extends keyof Features ? Features[K] : never }>
    & Readonly<{ dispose: () => void }>;

/** Mount the selected features on one provider scope for this editor. */
export function attachEditorLanguage<O extends Options>(editor: TextEditor, provider: LspWorkspace, options: O): Attachment<O> {
    requireLanguageView(editor);
    const owner = retainLspDocument(provider, editor.view.documentId);
    const features: Partial<Features> = {};
    function dispose() {
        features.hover?.dispose();
        features.completion?.dispose();
        features.diagnostics?.dispose();
        owner.dispose();
        editor.signal.removeEventListener("abort", dispose);
    }
    try {
        if (options.diagnostics) features.diagnostics = mountDiagnostic(editor, provider, options.diagnostics, owner);
        if (options.hover) {
            const hover = features.diagnostics && !options.hover.diagnostics
                ? { ...options.hover, diagnostics: features.diagnostics } : options.hover;
            features.hover = mountHover(editor, provider, hover, owner);
        }
        if (options.completion) features.completion = mountCompletion(editor, provider, options.completion, owner);
        editor.signal.addEventListener("abort", dispose, { once: true });
        return Object.freeze({ ...features, dispose }) as Attachment<O>;
    } catch (error) {
        dispose();
        throw error;
    }
}
