import { onAbort } from "./listen.ts";
import { requireLanguageView } from "./captured-view.ts";
import { retainLspDocument, type LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import { mountCompletion, type CompletionController, type CompletionControllerOptions } from "./completion-controller.ts";
import { mountDiagnostic, type DiagnosticController, type DiagnosticControllerOptions } from "./diagnostic-controller.ts";
import { mountHover, type HoverController, type HoverControllerOptions } from "./hover-controller.ts";
import type { HoverPopupAction } from "./hover-popup.ts";
import { mountDocumentColors, type DocumentColorController, type DocumentColorControllerOptions } from "./document-color-controller.ts";
import { mountDocumentLinks, type DocumentLinkController, type DocumentLinkControllerOptions } from "./document-link-controller.ts";
import type { TextEditor } from "./text-editor.ts";
import { mountSignature, type SignatureController, type SignatureControllerOptions } from "./signature-controller.ts";
import { mountOccurrences, type LspHighlightController } from "./lsp-highlights.ts";
import { mountCodeActions, type CodeActionController, type CodeActionControllerOptions } from "./code-action-controller.ts";
import { mountLanguageCommands, type LanguageCommands, type LanguageCommandOptions } from "./language-command.ts";
import { mountNavigation, type NavigationController, type NavigationControllerOptions } from "./navigation-controller.ts";
import { mountRename, type RenameController, type RenameControllerOptions } from "./rename-controller.ts";

type Options = {
    navigation?: NavigationControllerOptions;
    rename?: RenameControllerOptions;
    commands?: LanguageCommandOptions;
    codeActions?: CodeActionControllerOptions;
    completion?: CompletionControllerOptions;
    diagnostics?: DiagnosticControllerOptions;
    hover?: HoverControllerOptions;
    signature?: SignatureControllerOptions;
    occurrences?: Readonly<{ delayMs?: number }>;
    colors?: DocumentColorControllerOptions;
    links?: DocumentLinkControllerOptions;
};
type Features = {
    navigation: NavigationController;
    rename: RenameController;
    commands: LanguageCommands;
    codeActions: CodeActionController;
    completion: CompletionController;
    diagnostics: DiagnosticController;
    hover: HoverController;
    signature: SignatureController;
    occurrences: LspHighlightController;
    colors: DocumentColorController;
    links: DocumentLinkController;
};
type Attachment<O extends Options> = Readonly<{ [K in keyof O]: K extends keyof Features ? Features[K] : never }>
    & Readonly<{ dispose: () => void }>;

type Mounts = {
    [K in keyof Features]: (editor: TextEditor, owner: LspDocumentOwner, options: NonNullable<Options[K]>,
        features: Partial<Features>, attachment: Options) => Features[K];
};
const mounts: Mounts = {
    commands: mountLanguageCommands,
    codeActions: mountCodeActions,
    navigation: mountNavigation,
    rename: mountRename,
    diagnostics: mountDiagnostic,
    hover(editor, owner, settings, features, options) {
        const diagnostics = settings.diagnostics ?? features.diagnostics;
        const popup = settings.popup === true ? {} : settings.popup;
        if (!popup) return mountHover(editor, owner, { ...settings, ...(diagnostics && { diagnostics }) });
        return mountHover(editor, owner, { ...settings, ...(diagnostics && { diagnostics }), popup: {
            ...popup, actions(point, state) {
                const actions: HoverPopupAction[] = [];
                if (state.status === "ready" && options.codeActions?.popup && editor.commands.get("quickfix.show")?.enabled) {
                    actions.push({ label: "Code actions", run() {
                        const { selection } = editor.view.getSnapshot();
                        if ((point.offset < Math.min(selection.head, selection.anchor) || point.offset > Math.max(selection.head, selection.anchor))
                            && !editor.reveal({ from: point.offset, to: point.offset }, { expectedRevision: point.revision, select: true })) return;
                        editor.commands.run("quickfix.show");
                    } });
                }
                const mark = options.colors?.picker && features.colors?.colorAt(point.offset);
                if (mark) actions.push({ label: "Edit color", run: () => { features.colors?.openPicker(mark); } });
                const link = features.links?.linkAt(point.offset);
                const openLink = popup.openLink;
                if (link && openLink && (link.target === null ? link.canResolve : popup.canOpenLink?.(link.target) !== false)) {
                    actions.push({ label: "Open link", run: () => { void link.open(uri => {
                        if (features.hover?.getSnapshot() === state && popup.canOpenLink?.(uri) !== false) openLink(uri);
                    }); } });
                }
                return actions.concat(popup.actions?.(point, state) ?? []);
            },
        } });
    },
    completion: mountCompletion,
    signature: mountSignature,
    occurrences: mountOccurrences,
    colors: mountDocumentColors,
    links: mountDocumentLinks,
};

type Binding = { owner: LspDocumentOwner; users: number };
const bindings = new WeakMap<TextEditor, Map<LspWorkspace, Binding>>();

/** Independently mounted panels on the same editor and provider share its source binding. */
export function attachEditorLanguage<O extends Options>(editor: TextEditor, provider: LspWorkspace, options: O): Attachment<O> {
    requireLanguageView(editor);
    const scope = editor.workspace.createNotificationScope();
    scope.assertWritable();
    const providers = bindings.get(editor) ?? new Map<LspWorkspace, Binding>();
    const binding = providers.get(provider) ?? { owner: retainLspDocument(provider, editor.view.documentId), users: 0 };
    bindings.set(editor, providers);
    providers.set(provider, binding);
    binding.users++;
    let disposed = false;
    const features: Partial<Features> = {};
    function mount<K extends keyof Features>(key: K) {
        const settings = options[key];
        if (settings) features[key] = mounts[key](editor, binding.owner, settings, features, options);
    }
    function dispose() {
        if (disposed) return;
        scope.assertWritable();
        disposed = true;
        for (const feature of Object.values(features).reverse()) feature.dispose();
        if (!--binding.users) {
            providers.delete(provider);
            binding.owner.dispose();
        }
        editor.signal.removeEventListener("abort", dispose);
    }
    try {
        for (const key of Object.keys(mounts) as (keyof Features)[]) mount(key);
        onAbort(editor.signal, dispose);
        return Object.freeze({ ...features, dispose }) as Attachment<O>;
    } catch (error) {
        dispose();
        throw error;
    }
}
