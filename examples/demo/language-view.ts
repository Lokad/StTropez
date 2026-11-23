import { createCompletionController, createLspHighlightController, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { TextEditor, CompletionController, CompletionSnippet, LspHighlightController } from "../../src/browser/index.ts";
import type { Workspace } from "../../src/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import { mountDemoInspection } from "./inspect.ts";
import { mountDemoSymbols } from "./symbols.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { mountDemoActions } from "./actions.ts";
import { mountLanguageCommands } from "./language-commands.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";
import { completionPageSize } from "../shared/language/completion-list.ts";
import { mountCompletionList } from "./completion-list.ts";

/** Contextual completion UI around the public editor controller. It never changes text itself. */
export function mountDemoLanguage(workspace: Workspace, files: () => readonly DemoFile[], file: DemoFile, editor: TextEditor, language: DemoLanguage,
    open: (target: DemoSymbolTarget) => void, reportError: (error: unknown) => void, feedback: HTMLElement, snippetHost: HTMLElement) {
    const scope = new CleanupScope(); let disposed = false;
    const dispose = () => { disposed = true; scope.dispose(); };
    try {
        const target = workspace.tabs.capture(file.tab), listeners = new AbortController();
        scope.defer(() => listeners.abort());
        const popup = document.createElement("div"), count = document.createElement("div"), choices = document.createElement("div"), detail = document.createElement("pre");
        scope.defer(() => popup.remove());
        popup.className = "demo-completion"; popup.hidden = true; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Completions");
        count.className = "demo-completion-count";
        choices.className = "demo-completion-choices";
        popup.append(count, choices, detail); document.body.append(popup);
        const completionOverlay = mountAnchoredOverlay(editor, popup, { priority: 1 });
        scope.defer(completionOverlay.dispose);
        const renderChoices = mountCompletionList(choices, listeners.signal);
        const snippetPanel = document.createElement("div"); scope.defer(() => snippetPanel.remove());
        snippetPanel.className = "demo-snippet"; snippetPanel.hidden = true;
        snippetPanel.setAttribute("role", "region"); snippetPanel.setAttribute("aria-label", "Snippet controls"); snippetHost.append(snippetPanel);
        let controller: CompletionController | undefined;
        let renderedSnippet: CompletionSnippet | undefined;
        let inspection: ReturnType<typeof mountDemoInspection> | undefined;
        let symbols: ReturnType<typeof mountDemoSymbols> | undefined;
        let actions: ReturnType<typeof mountDemoActions> | undefined;
        let highlights: LspHighlightController | undefined;
        const commands = mountLanguageCommands(scope, editor, feedback, (command, menu) => {
            switch (command) {
                case "complete":
                    if (menu) { actions?.dismiss(); symbols?.dismiss(); inspection?.dismiss(); }
                    editor.commands.run("completion.request"); break;
                case "signature":
                    if (menu) controller?.cancel();
                    editor.commands.run("signature.request"); break;
                case "inspect": inspection?.inspect(); break;
                case "rename": symbols?.rename(); break;
                case "definition": symbols?.definition(); break;
                case "references": symbols?.references(); break;
                case "quickfix": actions?.request(); break;
            }
        }, reportError);
        const valid = () => !disposed && editor.element.isConnected && !editor.activity().disposed && workspace.tabs.resolve(target)?.surface.kind === "text";
        const render = () => {
            const state = controller?.getSnapshot();
            if (state) commands.feedback("complete", state.choices.length ? "" : state.pending ? "Getting completions…" : state.message, !state.pending || !!state.choices.length);
            const snippet = state?.snippet; snippetPanel.hidden = !valid() || !snippet;
            if (snippet && !snippetPanel.hidden && renderedSnippet !== snippet) {
                renderedSnippet = snippet;
                const label = document.createElement("span"); label.textContent = `Field ${snippet.position} of ${snippet.count} · Tab / Shift+Tab`;
                const button = (label: string, action: () => void) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", action); return node; };
                snippetPanel.replaceChildren(label, ...snippet.choices.map((value, index) => {
                    const node = button(value || "Empty value", () => snippet.choose(index)); node.setAttribute("aria-pressed", String(index === snippet.choiceIndex)); return node;
                }), button("Previous field", () => snippet.move(-1)), button("Next field", () => snippet.move(1)), button("Finish snippet", snippet.finish));
            }
            if (!valid() || !state?.anchor) { renderChoices(); completionOverlay.hide(); return; }
            count.textContent = `${state.choiceIndex + 1} of ${state.choices.length}${state.completionIncomplete ? " · partial list" : ""}${state.omittedCompletions.length ? ` · ${state.omittedCompletions.length} unsupported` : ""} · type to filter`;
            count.title = state.omittedCompletions.map(item => `${item.label}: ${item.reason}`).join("\n");
            renderChoices(state);
            detail.textContent = state.resolving ? "Loading details…" : state.completionDetail;
            completionOverlay.show(state.anchor);
        };
        snippetPanel.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
        popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
        const failMount = (error: unknown) => {
            disposed = true;
            try { scope.rollback(error); } catch (failure) { reportError(failure); }
        };
        const attach = (provider: LspWorkspace) => {
            if (!valid()) return;
            try {
                controller = createCompletionController(editor, provider, { autoConnect: false, filterManualCompletions: true, canCapture: valid,
                    getPageSize: () => completionPageSize(choices) });
                scope.defer(() => controller!.dispose());
                highlights = createLspHighlightController(editor, { provider });
                scope.defer(() => highlights!.dispose());
                const occurrences = editor.decorations.add({ name: "occurrences", order: 20, minimap: false });
                scope.defer(occurrences.dispose);
                let painted = highlights.getSnapshot().items;
                scope.defer(highlights.subscribe(() => {
                    const state = highlights!.getSnapshot();
                    if (painted === state.items) return;
                    painted = state.items;
                    if (valid() && state.items.length) occurrences.set(state.revision, state.items.map(item => ({
                        from: item.from, to: item.to, className: `demo-occurrence-${item.kind}`
                    })));
                    else occurrences.clear();
                }));
                inspection = mountDemoInspection(scope, workspace, file, editor, provider, language, valid, () => !!controller?.getSnapshot().choices.length || !!symbols?.isOpen() || !!actions?.isOpen(),
                    () => controller?.cancel(), () => { symbols?.dismiss(); actions?.dismiss(); },
                    state => {
                        if (state.status === "empty" || state.status === "failed") commands.feedback("signature", state.message, true);
                        else if (state.status === "ready") commands.feedback("signature", "", true);
                    });
                symbols = mountDemoSymbols(scope, workspace, files, file, editor, provider, valid, () => { controller?.cancel(); inspection?.dismiss(); actions?.dismiss(); }, open, commands.notice);
                actions = mountDemoActions(scope, workspace, file, editor, provider, language, valid, () => { controller?.cancel(); inspection?.dismiss(); symbols?.dismiss(); });
                scope.defer(controller.subscribe(render));
                const ready = () => { if (valid()) { controller!.connect(); render(); commands.ready(); } };
                if (provider.getSnapshot().phase === "ready") ready();
                else void language.connect().then(ready, () => { if (!disposed) commands.failed(); }).catch(failMount);
            } catch (error) { failMount(error); }
        };
        const prepared = language.preparedProvider;
        if (prepared) attach(prepared);
        else void language.prepare().then(attach, () => { if (!disposed) commands.failed(); });
        return Object.freeze({ dispose });
    } catch (error) { disposed = true; return scope.rollback(error); }
}
