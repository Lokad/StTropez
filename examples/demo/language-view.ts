import { createLspEditor } from "../../src/browser/index.ts";
import type { EditingCandidate, LspEditorController } from "../../src/browser/index.ts";
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
    const popup = document.createElement("div"), choices = document.createElement("div"), detail = document.createElement("pre");
    popup.className = "demo-completion"; popup.hidden = true; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Completions");
    popup.append(choices, detail); document.body.append(popup);
    let controller: LspEditorController | undefined, stop: (() => void) | undefined, disposed = false, rendered = "";
    let accepting: Readonly<{ id: number; index: number }> | undefined;
    let inspection: ReturnType<typeof mountDemoInspection> | undefined;
    let symbols: ReturnType<typeof mountDemoSymbols> | undefined;
    let actions: ReturnType<typeof mountDemoActions> | undefined;
    const valid = () => !disposed && editor.element.isConnected && !editor.snapshot().disposed && workspace.resolveTab(target)?.surface.kind === "text";
    const render = () => {
        const state = controller?.state.getSnapshot();
        popup.hidden = !valid() || !state?.choices.length || state.offerText === null;
        if (!state || popup.hidden) return;
        const key = `${state.completionId}:${state.choiceIndex}:${state.choices.join("\0")}`;
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
        const pending = accepting;
        if (pending && !state.resolving && !state.pending) {
            accepting = undefined;
            queueMicrotask(() => {
                const current = controller?.state.getSnapshot();
                if (valid() && current?.completionId === pending.id && current.choiceIndex === pending.index) controller?.apply("replace", pending.id);
            });
        }
    };
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: listeners.signal });
    popup.addEventListener("click", event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-index]"); if (!button || !controller) return;
        const index = Number(button.dataset.index), id = Number(button.dataset.completion);
        if (controller.chooseCompletion(index, id)) { accepting = { id, index }; render(); }
    }, { signal: listeners.signal });
    editor.element.addEventListener("sttropez-render", render, { signal: listeners.signal });
    editor.input.addEventListener("keydown", event => {
        if (!controller && (event.ctrlKey || event.metaKey) && event.code === "Space") event.preventDefault();
    }, { capture: true, signal: listeners.signal });
    void language.connect().then(provider => {
        if (!valid()) return;
        controller = createLspEditor(workspace, file.tab, editor, { provider, autoConnect: false, canCapture: valid });
        inspection = mountDemoInspection(workspace, file, editor, provider, valid, () => !!controller?.state.getSnapshot().choices.length || !!symbols?.isOpen() || !!actions?.isOpen(),
            () => controller?.cancel(), () => { symbols?.dismiss(); actions?.dismiss(); });
        symbols = mountDemoSymbols(workspace, files, file, editor, provider, valid, () => { controller?.cancel(); inspection?.dismiss(); actions?.dismiss(); }, open);
        actions = mountDemoActions(workspace, file, editor, provider, language, valid, () => { controller?.cancel(); inspection?.dismiss(); symbols?.dismiss(); });
        stop = controller.state.subscribe(render); controller.connect(); render();
    }).catch(() => { /* The project state renders a retry action while editing stays usable. */ });
    return Object.freeze({ complete: () => { actions?.dismiss(); symbols?.dismiss(); inspection?.dismiss(); editor.focus(); controller?.request(); }, inspect: () => inspection?.inspect(), signature: () => inspection?.signature(),
        definition: () => symbols?.definition(), references: () => symbols?.references(), rename: () => symbols?.rename(),
        quickfix: () => actions?.request(),
        destroy: () => { disposed = true; accepting = undefined; listeners.abort(); stop?.(); actions?.destroy(); symbols?.destroy(); inspection?.destroy(); controller?.destroy(); popup.remove(); } });
}
