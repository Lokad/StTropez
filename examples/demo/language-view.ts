import { completionFeedback } from "../shared/language/completion-feedback.ts";
import { attachEditorLanguage } from "../../src/browser/index.ts";
import type { TextEditor, CompletionController, CompletionSnippet, NavigationOrigin } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import type { DemoFile, DemoProject } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import { mountDemoSymbols } from "./symbols.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { demoActionPolicy, mountDemoActions } from "./actions.ts";
import { mountLanguageCommands } from "./language-commands.ts";
import { isMountedEditor } from "../shared/language-host.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";

/** Contextual completion UI around the public editor controller. It never changes text itself. */
export function mountDemoLanguage(
    project: DemoProject,
    file: DemoFile,
    editor: TextEditor,
    language: DemoLanguage,
    open: (target: DemoSymbolTarget, origin: NavigationOrigin) => void,
    reportError: (error: unknown) => void,
    feedback: HTMLElement,
    snippetHost: HTMLElement
) {
    const { workspace } = project;
    const scope = new CleanupScope();
    let disposed = false;
    const dispose = () => {
        disposed = true;
        scope.dispose();
    };
    try {
        const listeners = new AbortController();
        scope.defer(() => listeners.abort());
        const snippetPanel = document.createElement("div");
        scope.defer(() => snippetPanel.remove());
        snippetPanel.className = "demo-snippet";
        snippetPanel.hidden = true;
        snippetPanel.setAttribute("role", "region");
        snippetPanel.setAttribute("aria-label", "Snippet controls");
        snippetHost.append(snippetPanel);
        let controller: CompletionController | undefined;
        let renderedSnippet: CompletionSnippet | undefined;
        let symbols: ReturnType<typeof mountDemoSymbols> | undefined;
        let actions: ReturnType<typeof mountDemoActions> | undefined;
        const commands = mountLanguageCommands(
            scope,
            editor,
            feedback,
            (command) => {
                switch (command) {
                    case "complete":
                        editor.commands.run("completion.request");
                        break;
                    case "signature":
                        editor.commands.run("signature.request");
                        break;
                    case "inspect":
                        editor.focus();
                        editor.commands.run("hover.inspect");
                        break;
                    case "rename":
                        symbols?.rename();
                        break;
                    case "definition":
                        symbols?.definition();
                        break;
                    case "references":
                        symbols?.references();
                        break;
                    case "quickfix":
                        editor.commands.run("quickfix.show");
                        break;
                }
            },
            reportError
        );
        const valid = () => !disposed && isMountedEditor(workspace, editor);
        const canOpenLink = (target: string) => valid() && canOpenDemoHelp(target);
        const links = {
            canOpenLink,
            openLink(target: string) {
                if (canOpenLink(target)) window.open(target, "_blank", "noopener,noreferrer");
            }
        };
        const render = () => {
            const state = controller?.getSnapshot();
            if (state)
                commands.feedback(
                    "complete",
                    state.choices.length ? "" : completionFeedback(state),
                    !state.pending || !!state.choices.length
                );
            const snippet = state?.snippet;
            snippetPanel.hidden = !valid() || !snippet;
            if (snippet && !snippetPanel.hidden && renderedSnippet !== snippet) {
                renderedSnippet = snippet;
                const label = document.createElement("span");
                label.textContent = `Field ${snippet.position} of ${snippet.count} · Tab / Shift+Tab`;
                const button = (label: string, action: () => void) => {
                    const node = document.createElement("button");
                    node.type = "button";
                    node.textContent = label;
                    node.addEventListener("click", action);
                    return node;
                };
                snippetPanel.replaceChildren(
                    label,
                    ...snippet.choices.map((value, index) => {
                        const node = button(value || "Empty value", () => snippet.choose(index));
                        node.setAttribute("aria-pressed", String(index === snippet.choiceIndex));
                        return node;
                    }),
                    button("Previous field", () => snippet.move(-1)),
                    button("Next field", () => snippet.move(1)),
                    button("Finish snippet", snippet.finish)
                );
            }
        };
        snippetPanel.addEventListener("pointerdown", (event) => event.preventDefault(), { signal: listeners.signal });
        const failMount = (error: unknown) => {
            disposed = true;
            try {
                scope.rollback(error);
            } catch (failure) {
                reportError(failure);
            }
        };
        const attach = (provider: LspWorkspace) => {
            if (!valid()) return;
            try {
                const idle = () => {
                    const activity = editor.activity();
                    return valid() && activity.input === "idle";
                };
                const tools = attachEditorLanguage(editor, provider, {
                    ...demoActionPolicy(workspace, file, language, idle),
                    occurrences: {},
                    autoConnect: false,
                    linkPolicy: links,
                    completion: { filterManualCompletions: true, canCapture: valid, list: true },
                    signature: { popup: true, canCapture: valid },
                    hover: {
                        canCapture: idle,
                        popup: true,
                        diagnostics: {
                            subscribe: language.state.subscribe,
                            getSnapshot() {
                                const state = language.state.getSnapshot(),
                                    doc = workspace.document(file.resource.id);
                                return {
                                    diagnosticRevision: doc.revision,
                                    diagnosticsPending: state.checking,
                                    diagnostics: state.diagnostics.filter(
                                        (item) => item.documentId === doc.id && item.revision === doc.revision
                                    )
                                };
                            }
                        }
                    }
                });
                controller = tools.completion;
                scope.defer(tools.dispose);
                scope.defer(
                    tools.signature.subscribe(() => {
                        const state = tools.signature.getSnapshot();
                        if (state.status === "empty" || state.status === "failed")
                            commands.feedback("signature", state.message, true);
                        else if (state.status === "ready") commands.feedback("signature", "", true);
                    })
                );
                symbols = mountDemoSymbols(scope, project, editor, provider, valid, open, commands.notice);
                actions = mountDemoActions(scope, editor, tools.codeActions, idle);
                scope.defer(controller.subscribe(render));
                const ready = () => {
                    if (valid()) {
                        controller!.connect();
                        render();
                        commands.ready();
                    }
                };
                if (provider.getSnapshot().phase === "ready") ready();
                else
                    void language
                        .connect()
                        .then(ready, () => {
                            if (!disposed) commands.failed();
                        })
                        .catch(failMount);
            } catch (error) {
                failMount(error);
            }
        };
        const prepared = language.preparedProvider;
        if (prepared) attach(prepared);
        else
            void language.prepare().then(attach, () => {
                if (!disposed) commands.failed();
            });
        return Object.freeze({
            dispose,
            offerFixes: (host: HTMLElement, current: () => boolean) => actions?.offerFixes(host, current)
        });
    } catch (error) {
        disposed = true;
        return scope.rollback(error);
    }
}
