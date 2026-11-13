import { createLspEditor, createLspHighlightController } from "../../src/browser/index.ts";
import type { EditingCandidate, InlineDecoration, PresentedLine, LspEditorController, LspHighlightController } from "../../src/browser/index.ts";
import type { Workspace } from "../../src/index.ts";
import type { DemoFile } from "./project.ts";
import type { DemoLanguage } from "./language.ts";
import { mountDemoInspection } from "./inspect.ts";
import { mountDemoSymbols } from "./symbols.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { mountDemoActions } from "./actions.ts";

/** Contextual completion UI around the public editor controller. It never changes text itself. */
export function mountDemoLanguage(workspace: Workspace, files: readonly DemoFile[], file: DemoFile, editor: EditingCandidate, language: DemoLanguage, open: (target: DemoSymbolTarget) => void) {
    const target = workspace.captureTab(file.tab), listeners = new AbortController();
    const popup = document.createElement("div"), count = document.createElement("div"), choices = document.createElement("div"), detail = document.createElement("pre");
    popup.className = "demo-completion"; popup.hidden = true; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Completions");
    count.className = "demo-completion-count";
    popup.append(count, choices, detail); document.body.append(popup);
    const snippetPanel = document.createElement("div"); snippetPanel.className = "demo-snippet"; snippetPanel.hidden = true;
    snippetPanel.setAttribute("role", "region"); snippetPanel.setAttribute("aria-label", "Snippet controls"); document.body.append(snippetPanel);
    let controller: LspEditorController | undefined, stop: (() => void) | undefined, disposed = false, rendered = "";
    let renderedSnippet = 0;
    let inspection: ReturnType<typeof mountDemoInspection> | undefined;
    let symbols: ReturnType<typeof mountDemoSymbols> | undefined;
    let actions: ReturnType<typeof mountDemoActions> | undefined;
    let highlights: LspHighlightController | undefined, stopHighlights: (() => void) | undefined;
    const valid = () => !disposed && editor.element.isConnected && !editor.snapshot().disposed && workspace.resolveTab(target)?.surface.kind === "text";
    const render = () => {
        const state = controller?.state.getSnapshot();
        const snippet = state?.snippet; snippetPanel.hidden = !valid() || !snippet;
        if (snippet && !snippetPanel.hidden && renderedSnippet !== snippet.id) {
            renderedSnippet = snippet.id;
            const label = document.createElement("span"); label.textContent = `Field ${snippet.position} of ${snippet.count} · Tab / Shift+Tab`;
            const button = (label: string, action: () => void) => { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", action); return node; };
            snippetPanel.replaceChildren(label, ...snippet.choices.map((value, index) => {
                const node = button(value || "Empty value", () => controller?.chooseSnippet(index, snippet.id)); node.setAttribute("aria-pressed", String(index === snippet.choiceIndex)); return node;
            }), button("Previous field", () => controller?.moveSnippet(-1, snippet.id)), button("Next field", () => controller?.moveSnippet(1, snippet.id)), button("Finish snippet", () => { if (controller?.state.getSnapshot().snippet?.id === snippet.id) controller.cancel(); }));
        }
        popup.hidden = !valid() || !state?.choices.length || state.offerText === null;
        if (!state || popup.hidden) return;
        count.textContent = `${state.choiceIndex + 1} of ${state.choices.length}${state.completionIncomplete ? " · partial list" : ""}${state.omittedCompletions.length ? ` · ${state.omittedCompletions.length} unsupported` : ""} · type to filter`;
        count.title = state.omittedCompletions.map(item => `${item.label}: ${item.reason}`).join("\n");
        const key = `${state.completionId}:${state.choiceIndex}`;
        if (rendered !== key) {
            rendered = key;
            const first = Math.max(0, state.choiceIndex - 7), last = Math.min(state.choices.length, first + 16);
            choices.replaceChildren(...state.choices.slice(first, last).map((label, offset) => {
                const option = document.createElement("button"); option.textContent = label; option.type = "button";
                option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(first + offset === state.choiceIndex));
                option.dataset.index = String(first + offset); option.dataset.completion = String(state.completionId); return option;
            }));
        }
        detail.textContent = state.resolving ? "Loading details…" : state.completionDetail;
        const selected = editor.view.getSnapshot().selection.head, point = editor.viewport.coordsAt(selected), box = editor.element.getBoundingClientRect();
        const left = point?.left ?? box.left + 16, top = point ? point.top + point.height + 4 : box.top + 32;
        popup.style.left = `${Math.max(8, Math.min(innerWidth - 350, left))}px`; popup.style.top = `${Math.max(8, Math.min(innerHeight - 320, top))}px`;
    };
    snippetPanel.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    popup.addEventListener("click", event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-index]"); if (!button || !controller) return;
        const index = Number(button.dataset.index), id = Number(button.dataset.completion);
        if (controller.chooseCompletion(index, id)) controller.accept("replace", id);
    }, { signal: listeners.signal });
    editor.element.addEventListener("sttropez-render", render, { signal: listeners.signal });
    editor.input.addEventListener("keydown", event => {
        if (!controller && (event.ctrlKey || event.metaKey) && event.code === "Space") event.preventDefault();
    }, { capture: true, signal: listeners.signal });
    void language.connect().then(provider => {
        if (!valid()) return;
        controller = createLspEditor(workspace, file.tab, editor, { provider, autoConnect: false, filterManualCompletions: true, canCapture: valid });
        highlights = createLspHighlightController(workspace, file.tab, editor, { provider });
        stopHighlights = highlights.state.subscribe(() => editor.viewport.invalidate());
        inspection = mountDemoInspection(workspace, file, editor, provider, valid, () => !!controller?.state.getSnapshot().choices.length || !!symbols?.isOpen() || !!actions?.isOpen(),
            () => controller?.cancel(), () => { symbols?.dismiss(); actions?.dismiss(); });
        symbols = mountDemoSymbols(workspace, files, file, editor, provider, valid, () => { controller?.cancel(); inspection?.dismiss(); actions?.dismiss(); }, open);
        actions = mountDemoActions(workspace, file, editor, provider, language, valid, () => { controller?.cancel(); inspection?.dismiss(); symbols?.dismiss(); });
        stop = controller.state.subscribe(render); controller.connect(); render();
    }).catch(() => { /* The project state renders a retry action while editing stays usable. */ });
    return Object.freeze({ complete: () => { actions?.dismiss(); symbols?.dismiss(); inspection?.dismiss(); editor.focus(); controller?.request(); }, inspect: () => inspection?.inspect(), signature: () => inspection?.signature(),
        definition: () => symbols?.definition(), references: () => symbols?.references(), rename: () => symbols?.rename(),
        quickfix: () => actions?.request(),
        decorate: (line: PresentedLine): readonly InlineDecoration[] => {
            const state = highlights?.state.getSnapshot();
            if (!valid() || state?.documentId !== line.documentId || state.revision !== line.revision) return [];
            return highlights!.intersect(line.from, line.to).map(item => ({ from: item.from, to: item.to, className: `demo-occurrence-${item.kind}` }));
        },
        destroy: () => { disposed = true; listeners.abort(); stop?.(); stopHighlights?.(); highlights?.dispose(); actions?.destroy(); symbols?.destroy(); inspection?.destroy(); controller?.destroy(); popup.remove(); snippetPanel.remove(); } });
}
