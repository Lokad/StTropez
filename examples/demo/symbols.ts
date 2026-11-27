import type { DocumentId } from "../../src/index.ts";
import { attachEditorLanguage } from "../../src/browser/index.ts";
import type { NavigationOrigin, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import type { DemoProject } from "./project.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
export type DemoSymbolTarget = Readonly<{ documentId: DocumentId; revision: number; from: number; to: number }>;

/** Host presentation around validated public results. Navigation may replace this editor view. */
export function mountDemoSymbols(
    scope: CleanupScope,
    project: DemoProject,
    editor: TextEditor,
    provider: LspWorkspace,
    valid: () => boolean,
    open: (target: DemoSymbolTarget, origin: NavigationOrigin) => void,
    notice: (message: string, signal: AbortSignal) => void
) {
    const { workspace } = project;
    const fileAt = (documentId: string) => project.files.find((file) => file.resource.id === documentId);
    const events = new AbortController();
    scope.defer(() => events.abort());
    const language = attachEditorLanguage(editor, provider, {
        navigation: {
            canCapture: valid,
            documents: () => project.files.map((file) => workspace.document(file.resource.id)),
            chooser: {
                fileLabel: (at) => fileAt(at.document.documentId)?.name ?? at.document.uri,
                capture(_kind, offset) {
                    const origin = project.navigation.capture(editor, offset);
                    if (!origin) return;
                    return (at) => {
                        const file = fileAt(at.document.documentId);
                        if (file)
                            open(
                                {
                                    documentId: file.resource.id,
                                    revision: at.document.revision,
                                    from: at.from,
                                    to: at.from
                                },
                                origin
                            );
                    };
                }
            }
        },
        rename: { canCapture: valid, popup: { onNotice: (message) => notice(message, events.signal) } }
    });
    scope.defer(language.dispose);
    return {
        definition: () => {
            void language.navigation.request("definition");
        },
        references: () => {
            void language.navigation.request("references");
        },
        rename: () => editor.commands.run("rename.start")
    };
}
