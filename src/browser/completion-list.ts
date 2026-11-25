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
    const list = editorElement(doc, "div", "completion-choices");
    const detail = doc.createElement("pre");
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", strings.label ?? "Completions");
    popup.append(count, list, detail);
    const overlay = mountAnchoredOverlay(editor, popup, { priority: 1 });
    const rowHeight = 30;
    const windowSize = 16;
    list.style.setProperty("--st-completion-row", `${rowHeight}px`);
    let current: CompletionSnapshot | undefined;
    let first = -1;
    let followSelection = true;

    function paint(scrollTop: number): void {
        if (!current) return;
        const { choices, choiceIndex, completionAt } = current;
        const start = Math.max(0, Math.min(choices.length - windowSize, Math.floor(scrollTop / rowHeight) - 2));
        if (start === first) return;
        first = start;
        list.replaceChildren(...choices.slice(start, start + windowSize).map((label, offset) => {
            const index = start + offset;
            const choice = completionAt(index);
            const button = doc.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.title = label;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", String(index === choiceIndex));
            button.style.top = `${index * rowHeight}px`;
            button.onclick = () => choice?.accept("replace");
            return button;
        }));
    }
    function reveal(): void {
        if (!current) return;
        const top = current.choiceIndex * rowHeight, height = list.clientHeight;
        if (height && followSelection) {
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + rowHeight > list.scrollTop + height) list.scrollTop = top + rowHeight - height;
        }
        paint(height ? list.scrollTop : top);
    }
    list.onscroll = () => {
        if (!current || !list.clientHeight) return;
        const top = current.choiceIndex * rowHeight;
        followSelection = top >= list.scrollTop && top + rowHeight <= list.scrollTop + list.clientHeight + 1;
        paint(list.scrollTop);
    };
    popup.onpointerdown = event => event.preventDefault();
    const resize = new doc.defaultView!.ResizeObserver(reveal);
    resize.observe(list);
    function render() {
        const state = source.getSnapshot();
        if (!state.anchor) {
            if (current) list.replaceChildren();
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
            first = -1;
            followSelection = true;
            list.style.setProperty("--st-completion-extent", state.choices.length * rowHeight + "px");
        }
        reveal();
        overlay.show(state.anchor);
    }
    const stop = source.subscribe(render);
    return { pageSize: () => Math.floor(list.clientHeight / rowHeight), dispose() {
        stop();
        resize.disconnect();
        overlay.dispose();
        list.replaceChildren();
        current = undefined;
    } };
}
