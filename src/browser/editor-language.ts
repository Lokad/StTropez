import { requireLanguageView } from "./captured-view.ts";
import { retainLspDocument } from "../protocol/lsp-client.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import { mountCompletion, type CompletionController, type CompletionControllerOptions } from "./completion-controller.ts";
import { mountDiagnostic, type DiagnosticController, type DiagnosticControllerOptions } from "./diagnostic-controller.ts";
import { mountHover, type HoverController, type HoverControllerOptions } from "./hover-controller.ts";
import { mountDocumentColors, type DocumentColorController, type DocumentColorControllerOptions } from "./document-color-controller.ts";
import { mountDocumentLinks, type DocumentLinkController, type DocumentLinkControllerOptions } from "./document-link-controller.ts";
import type { TextEditor } from "./text-editor.ts";
import { mountSignature, type SignatureController, type SignatureControllerOptions } from "./signature-controller.ts";

type Options = {
    completion?: CompletionControllerOptions;
    diagnostics?: DiagnosticControllerOptions;
    hover?: HoverControllerOptions;
    signature?: SignatureControllerOptions;
    colors?: DocumentColorControllerOptions;
    links?: DocumentLinkControllerOptions;
};
type Features = {
    completion: CompletionController;
    diagnostics: DiagnosticController;
    hover: HoverController;
    signature: SignatureController;
    colors: DocumentColorController;
    links: DocumentLinkController;
};
type Attachment<O extends Options> = Readonly<{ [K in keyof O]: K extends keyof Features ? Features[K] : never }>
    & Readonly<{ dispose: () => void }>;

/** Mount the selected features on one provider scope for this editor. */
export function attachEditorLanguage<O extends Options>(editor: TextEditor, provider: LspWorkspace, options: O): Attachment<O> {
    requireLanguageView(editor);
    const owner = retainLspDocument(provider, editor.view.documentId);
    const features: Partial<Features> = {};
    function dispose() {
        for (const feature of Object.values(features).reverse()) feature.dispose();
        owner.dispose();
        editor.signal.removeEventListener("abort", dispose);
    }
    try {
        if (options.diagnostics) features.diagnostics = mountDiagnostic(editor, provider, options.diagnostics, owner);
        if (options.hover) {
            const hover = features.diagnostics && !options.hover.diagnostics
                ? { ...options.hover, diagnostics: features.diagnostics } : options.hover;
            features.hover = mountHover(editor, owner, hover);
        }
        if (options.completion) features.completion = mountCompletion(editor, provider, options.completion, owner);
        if (options.signature) features.signature = mountSignature(editor, owner, options.signature);
        if (options.colors) features.colors = mountDocumentColors(editor, provider, options.colors, owner);
        if (options.links) features.links = mountDocumentLinks(editor, provider, options.links, owner);
        editor.signal.addEventListener("abort", dispose, { once: true });
        return Object.freeze({ ...features, dispose }) as Attachment<O>;
    } catch (error) {
        dispose();
        throw error;
    }
}
