import { choiceRows } from "./choice-rows.ts";
import { editorElement } from "./editor-element.ts";
import type { Observable } from "../core/observable.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import type { CompletionSnapshot } from "./completion-controller.ts";
import type { TextEditor } from "./text-editor.ts";

export type CompletionListStrings = Readonly<{
    label?: string;
    status?: (state: CompletionSnapshot) => string;
    omitted?: (state: CompletionSnapshot) => string;
    loadingDetail?: string;
}>;

/** The scroll track represents every candidate. Each mounted button retains its captured choice. */
export function mountCompletionList(editor: TextEditor, source: Observable<CompletionSnapshot>,
    strings: CompletionListStrings, filterManual: boolean) {
    const doc = editor.element.ownerDocument;
    const popup = editorElement(doc, "div", "completion");
    const count = editorElement(doc, "div", "completion-count");
    const detail = doc.createElement("pre");
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", strings.label ?? "Completions");
    popup.append(count);
    const rows = choiceRows(popup, 30);
    popup.append(detail);
    const overlay = mountAnchoredOverlay(editor, popup, { priority: 1 });
    let current: CompletionSnapshot | undefined;
    popup.onpointerdown = event => event.preventDefault();
    function render() {
        const state = source.getSnapshot();
        if (!state.anchor) {
            if (current) rows.set(0, 0);
            current = undefined;
            overlay.hide();
            return;
        }
        const omitted = state.omittedCompletions;
        count.textContent = strings.status?.(state) ?? ((state.choiceIndex + 1) + " of " + state.choices.length
            + (state.completionIncomplete ? " · partial list" : "") + (omitted.length ? " · " + omitted.length + " unsupported" : "")
            + (filterManual ? " · type to filter" : ""));
        count.title = strings.omitted?.(state) ?? omitted.map(item => item.label + ": " + item.reason).join("\n");
        detail.textContent = state.resolving ? strings.loadingDetail ?? "Loading details…" : state.completionDetail;
        if (current?.choices !== state.choices || current?.choiceIndex !== state.choiceIndex) {
            current = state;
            rows.set(state.choices.length, state.choiceIndex, (index, button) => {
                const label = state.choices[index]!;
                const choice = state.completionAt(index);
                button.textContent = label;
                button.title = label;
                button.onclick = () => choice?.accept("replace");
            });
        } else rows.reveal();
        overlay.show(state.anchor);
    }
    const stop = source.subscribe(render);
    return { pageSize: rows.pageSize, dispose() {
        stop();
        rows.dispose();
        overlay.dispose();
        current = undefined;
    } };
}
