import type { TextComparison, TextComparisonSnapshot } from "./comparison.ts";
import { textExcerpt } from "../core/utf16.ts";

/** Optional presentation. Pane ownership and command validation stay with the comparison. */
export function mountComparisonControls(
    comparison: Pick<TextComparison, "element" | "activePane" | "getSnapshot" | "subscribe" | "revertSelectedHunk" | "setScrollLinked" | "setRowsAligned">,
    referencePane: HTMLElement, workingPane: HTMLElement
): () => void {
    const owner = comparison.element.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => owner.createElement(tag);
    const controls = element("div");
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    controls.className = "st-comparison-controls";
    const button = (label: string) => {
        const result = element("button");
        result.type = "button";
        result.textContent = label;
        controls.append(result);
        return result;
    };
    const previous = button("Previous change"), next = button("Next change"), revert = button("Use baseline");
    controls.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse" && event.button === 0
            && (event.target === previous || event.target === next || event.target === revert)) event.preventDefault();
    }, { capture: true, ...options });
    function bindNavigation(control: HTMLButtonElement, id: string): void {
        const hint = () => { control.title = comparison.activePane().keymap.getShortcuts(id).join(" or "); };
        control.addEventListener("pointerenter", hint, options);
        control.addEventListener("focus", hint, options);
        control.addEventListener("click", event => {
            const pane = comparison.activePane();
            if (pane.commands.run(id) && event.detail > 0) pane.focus();
        }, options);
        hint();
    }
    bindNavigation(previous, "comparison.previousChange"); bindNavigation(next, "comparison.nextChange");
    const checkbox = (label: string) => {
        const wrapper = element("label");
        const input = element("input");
        input.type = "checkbox";
        wrapper.append(input, ` ${label}`);
        controls.append(wrapper);
        return input;
    };
    const link = checkbox("Link review scrolling");
    const align = checkbox("Align review rows");
    const status = element("output");
    controls.append(status);
    const message = element("span");
    status.append(message);
    status.dataset.pendingLabel = "Updating…";
    const referenceHeading = element("h3");
    const workingHeading = element("h3");
    referencePane.prepend(referenceHeading);
    workingPane.prepend(workingHeading);
    const preview = element("div");
    const referencePreview = element("pre");
    const workingPreview = element("pre");
    preview.className = "st-comparison-preview";
    preview.setAttribute("aria-label", "Change preview");
    const previewHint = element("span");
    previewHint.textContent = "Select a changed line to preview it.";
    preview.append(referencePreview, workingPreview, previewHint);
    comparison.element.prepend(controls);
    comparison.element.append(preview);
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    const visible = (value: string) => value.replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\r", "␍").replaceAll("\n", "↵\n");
    let rendered: TextComparisonSnapshot | undefined, hasCompletedResult = false;
    function render(): void {
        const current = comparison.getSnapshot(), old = rendered;
        // Cursor counters do not change this control surface or its bounded preview.
        if (old && old.comparison.generation === current.comparison.generation && old.comparison.status === current.comparison.status
            && old.selectedHunk === current.selectedHunk && old.canNavigate === current.canNavigate && old.canRevert === current.canRevert
            && old.scrollLinked === current.scrollLinked && old.alignment.enabled === current.alignment.enabled
            && old.alignment.status === current.alignment.status && old.alignment.pending === current.alignment.pending && old.disposed === current.disposed) return;
        rendered = current;
        const { comparison: state, selectedHunk: selected, canNavigate, canRevert, scrollLinked, alignment: layout, disposed } = current;
        const count = state.hunks.length, hunk = selected === null ? undefined : state.hunks[selected];
        const total = count.toLocaleString();
        const position = selected === null ? undefined : `${(selected + 1).toLocaleString()} of ${total}`;
        link.checked = scrollLinked; align.checked = layout.enabled; link.disabled = align.disabled = disposed || !state.baseline || !state.working;
        previous.disabled = next.disabled = !canNavigate; revert.disabled = !canRevert;
        revert.title = position ? `Restore change ${position} from the baseline` : "Place the caret in a change";
        setText(referenceHeading, state.baseline ? `Baseline · ${state.baseline.version}` : "Baseline unavailable");
        setText(workingHeading, state.working ? `Working · revision ${state.working.revision}` : "Working unavailable");
        // A new reference or a break in the edit history cannot reuse the previous preview.
        // Buttons above already reflect the live command guards, including during a short edit.
        const retainResult = hasCompletedResult && state.status === "running" && old !== undefined && state.baseline === old.comparison.baseline
            && state.working?.change != null && (state.generation === old.comparison.generation
                || state.working.change.previousRevision === old.comparison.working?.revision);
        controls.toggleAttribute("data-updating", retainResult);
        align.title = layout.pending ? "Preparing aligned rows" : "";
        if (retainResult) {
            status.setAttribute("aria-busy", "true"); preview.title = "Last completed comparison";
            return;
        }
        status.removeAttribute("aria-busy"); preview.removeAttribute("title");
        hasCompletedResult = state.status === "ready";
        const described = hunk ?? (count === 1 ? state.hunks[0] : undefined);
        const detail = described?.lineEndingOnly ? " · line endings only" : described?.whitespaceOnly ? " · whitespace only" : "";
        const summary = position ? `Change ${position}` : count ? `${total} ${count === 1 ? "change" : "changes"}` : "No changes";
        const result = state.status === "ready" ? summary + detail : state.failure ?? `Comparison ${state.status}`;
        setText(message, result + (layout.status === "failed" ? " · row alignment unavailable" : ""));
        preview.hidden = state.status !== "ready" || count === 0;
        previewHint.hidden = !!hunk; referencePreview.hidden = workingPreview.hidden = !hunk;
        if (old?.selectedHunk !== selected) { preview.scrollTop = 0; preview.scrollLeft = 0; }
        if (hunk && state.baseline && state.working) {
            const text = (side: "baseline" | "working") => {
                const { from, to, lineFrom, lineTo } = hunk[side];
                if (from === to) return side === "baseline" ? "Baseline: no text removed" : "Working: no text added";
                const first = lineFrom + 1;
                const lines = first === lineTo ? `line ${first}` : `lines ${first}–${lineTo}`;
                const excerpt = textExcerpt(state[side]!.buffer, 160, "…", from, to);
                return `${side === "baseline" ? "Baseline" : "Working"} ${lines}: ${visible(excerpt)}`;
            };
            setText(referencePreview, text("baseline")); setText(workingPreview, text("working"));
        } else { setText(referencePreview, ""); setText(workingPreview, ""); }
    }
    let press: TextComparisonSnapshot | null | undefined;
    revert.addEventListener("pointerdown", () => { press = comparison.getSnapshot(); }, options);
    revert.addEventListener("keydown", event => {
        if (!event.repeat && (event.key === " " || event.key === "Enter")) press = comparison.getSnapshot();
    }, options);
    revert.addEventListener("pointercancel", () => { press = undefined; }, options);
    revert.addEventListener("blur", () => { if (press) press = null; }, options);
    revert.addEventListener("click", event => {
        const shown = event.isTrusted ? press : undefined; press = undefined;
        if (shown !== null) comparison.revertSelectedHunk(shown);
    }, options);
    link.addEventListener("change", () => comparison.setScrollLinked(link.checked), options);
    align.addEventListener("change", () => comparison.setRowsAligned(align.checked), options);
    const stop = comparison.subscribe(render); render();
    return () => { stop(); listeners.abort(); controls.remove(); preview.remove(); referenceHeading.remove(); workingHeading.remove(); };
}
