import { createCompletionController, createLspHighlightController } from "../../src/browser/index.ts";
import type { TextEditor, CompletionController, CompletionSnippet, LspHighlightController } from "../../src/browser/index.ts";
import type { Workspace } from "../../src/index.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import { mountDemoInspection } from "./inspect.ts";
import { mountDemoSymbols } from "./symbols.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { mountDemoActions } from "./actions.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";

/** Contextual completion UI around the public editor controller. It never changes text itself. */
export function mountDemoLanguage(workspace: Workspace, files: () => readonly DemoFile[], file: DemoFile, editor: TextEditor, language: DemoLanguage,
    open: (target: DemoSymbolTarget) => void, reportError: (error: unknown) => void) {
    const scope = new CleanupScope(); let disposed = false;
    const dispose = () => { disposed = true; scope.dispose(); };
    try {
        const target = workspace.tabs.capture(file.tab), listeners = new AbortController();
        scope.defer(() => listeners.abort());
        const popup = document.createElement("div"), count = document.createElement("div"), choices = document.createElement("div"), detail = document.createElement("pre");
        scope.defer(() => popup.remove());
        popup.className = "demo-completion"; popup.hidden = true; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Completions");
        count.className = "demo-completion-count";
        popup.append(count, choices, detail); document.body.append(popup);
        const snippetPanel = document.createElement("div"); scope.defer(() => snippetPanel.remove());
        snippetPanel.className = "demo-snippet"; snippetPanel.hidden = true;
        snippetPanel.setAttribute("role", "region"); snippetPanel.setAttribute("aria-label", "Snippet controls"); document.body.append(snippetPanel);
        let controller: CompletionController | undefined, renderedChoices: readonly string[] | undefined, renderedIndex = -1;
        let renderedSnippet: CompletionSnippet | undefined;
        let inspection: ReturnType<typeof mountDemoInspection> | undefined;
        let symbols: ReturnType<typeof mountDemoSymbols> | undefined;
        let actions: ReturnType<typeof mountDemoActions> | undefined;
        let highlights: LspHighlightController | undefined;
        const valid = () => !disposed && editor.element.isConnected && !editor.activity().disposed && workspace.tabs.resolve(target)?.surface.kind === "text";
        const render = () => {
            const state = controller?.getSnapshot();
            const snippet = state?.snippet; snippetPanel.hidden = !valid() || !snippet;
            if (snippet && !snippetPanel.hidden && renderedSnippet !== snippet) {
                renderedSnippet = snippet;
                const label = document.createElement("span"); label.textContent = `Field ${snippet.position} of ${snippet.count} · Tab / Shift+Tab`;
                const button = (label: string, action: () => void) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", action); return node; };
                snippetPanel.replaceChildren(label, ...snippet.choices.map((value, index) => {
                    const node = button(value || "Empty value", () => snippet.choose(index)); node.setAttribute("aria-pressed", String(index === snippet.choiceIndex)); return node;
                }), button("Previous field", () => snippet.move(-1)), button("Next field", () => snippet.move(1)), button("Finish snippet", snippet.finish));
            }
            popup.hidden = !valid() || !state?.choices.length || state.offerText === null;
            if (!state || popup.hidden) return;
            count.textContent = `${state.choiceIndex + 1} of ${state.choices.length}${state.completionIncomplete ? " · partial list" : ""}${state.omittedCompletions.length ? ` · ${state.omittedCompletions.length} unsupported` : ""} · type to filter`;
            count.title = state.omittedCompletions.map(item => `${item.label}: ${item.reason}`).join("\n");
            if (renderedChoices !== state.choices || renderedIndex !== state.choiceIndex) {
                renderedChoices = state.choices; renderedIndex = state.choiceIndex;
                const first = Math.max(0, state.choiceIndex - 7), last = Math.min(state.choices.length, first + 16);
                choices.replaceChildren(...state.choices.slice(first, last).map((label, offset) => {
                    const option = document.createElement("button"); option.textContent = label; option.type = "button";
                    option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(first + offset === state.choiceIndex));
                    const choice = state.completionAt(first + offset);
                    option.onclick = () => choice?.accept("replace"); return option;
                }));
            }
            detail.textContent = state.resolving ? "Loading details…" : state.completionDetail;
            const selected = editor.view.getSnapshot().selection.head, point = editor.viewport.coordsAt(selected), box = editor.element.getBoundingClientRect();
            const left = point?.left ?? box.left + 16, top = point ? point.top + point.height + 4 : box.top + 32;
            popup.style.left = `${Math.max(8, Math.min(innerWidth - 350, left))}px`; popup.style.top = `${Math.max(8, Math.min(innerHeight - 320, top))}px`;
        };
        snippetPanel.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
        popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
        scope.defer(editor.viewport.onRender(render));
        editor.input.addEventListener("keydown", event => {
            if (!controller && (event.ctrlKey || event.metaKey) && event.code === "Space") event.preventDefault();
        }, { capture: true, signal: listeners.signal });
        void language.connect().then(provider => {
            if (!valid()) return;
            try {
                controller = createCompletionController(editor, provider, { autoConnect: false, filterManualCompletions: true, canCapture: valid });
                scope.defer(() => controller!.dispose());
                highlights = createLspHighlightController(editor, { provider });
                scope.defer(() => highlights!.dispose());
                const occurrences = editor.decorations.add({ name: "occurrences", order: 20, minimap: false });
                scope.defer(occurrences.dispose);
                scope.defer(highlights.subscribe(() => {
                    const state = highlights!.getSnapshot();
                    if (valid() && state.items.length) occurrences.set(state.revision, state.items.map(item => ({
                        from: item.from, to: item.to, className: `demo-occurrence-${item.kind}`
                    })));
                    else occurrences.clear();
                }));
                inspection = mountDemoInspection(scope, workspace, file, editor, provider, valid, () => !!controller?.getSnapshot().choices.length || !!symbols?.isOpen() || !!actions?.isOpen(),
                    () => controller?.cancel(), () => { symbols?.dismiss(); actions?.dismiss(); });
                symbols = mountDemoSymbols(scope, workspace, files, file, editor, provider, valid, () => { controller?.cancel(); inspection?.dismiss(); actions?.dismiss(); }, open);
                actions = mountDemoActions(scope, workspace, file, editor, provider, language, valid, () => { controller?.cancel(); inspection?.dismiss(); symbols?.dismiss(); });
                scope.defer(controller.subscribe(render)); controller.connect(); render();
            } catch (error) {
                disposed = true;
                try { scope.rollback(error); } catch (failure) { reportError(failure); }
            }
        }, () => { /* Connection failure is already reported by the project, with its own retry. */ });
        return Object.freeze({ complete: () => { actions?.dismiss(); symbols?.dismiss(); inspection?.dismiss(); editor.focus(); controller?.request(); }, inspect: () => inspection?.inspect(), signature: () => inspection?.signature(),
            definition: () => symbols?.definition(), references: () => symbols?.references(), rename: () => symbols?.rename(),
            quickfix: () => actions?.request(),
            dispose });
    } catch (error) { disposed = true; return scope.rollback(error); }
}
