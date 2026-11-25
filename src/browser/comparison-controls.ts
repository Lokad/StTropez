import type { TextComparison, TextComparisonSnapshot, TextComparisonStrings } from "./comparison.ts";
import { textExcerpt } from "../core/utf16.ts";

export function sameControlState(a: TextComparisonSnapshot, b: TextComparisonSnapshot): boolean {
    return a.selectedHunk === b.selectedHunk && a.canNavigate === b.canNavigate && a.canRevert === b.canRevert
        && a.scrollLinked === b.scrollLinked && a.disposed === b.disposed
        && a.alignment.enabled === b.alignment.enabled && a.alignment.status === b.alignment.status
        && a.alignment.pending === b.alignment.pending;
}

/** Optional presentation. Pane ownership and command validation stay with the comparison. */
export function mountComparisonControls(
    comparison: Pick<TextComparison, "element" | "activePane" | "getSnapshot" | "subscribe" | "revertSelectedHunk" | "setScrollLinked" | "setRowsAligned">,
    referencePane: HTMLElement, workingPane: HTMLElement, strings: TextComparisonStrings
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
    const previous = navigationButton("comparison.previousChange");
    const next = navigationButton("comparison.nextChange");
    const revert = button(strings.useBaseline ?? "Use baseline");
    controls.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse" && event.button === 0
            && (event.target === previous || event.target === next || event.target === revert)) event.preventDefault();
    }, { capture: true, ...options });
    function navigationButton(id: string): HTMLButtonElement {
        const control = button(comparison.activePane().commands.get(id)!.label);
        const hint = () => { control.title = comparison.activePane().keymap.getShortcuts(id).join(strings.shortcutSeparator ?? " or "); };
        control.addEventListener("pointerenter", hint, options);
        control.addEventListener("focus", hint, options);
        control.addEventListener("click", event => {
            const pane = comparison.activePane();
            if (pane.commands.run(id) && event.detail > 0) pane.focus();
        }, options);
        hint();
        return control;
    }
    const checkbox = (label: string) => {
        const wrapper = element("label");
        const input = element("input");
        input.type = "checkbox";
        wrapper.append(input, ` ${label}`);
        controls.append(wrapper);
        return input;
    };
    const link = checkbox(strings.linkScrolling ?? "Link review scrolling");
    const align = checkbox(strings.alignRows ?? "Align review rows");
    const status = element("output");
    controls.append(status);
    const message = element("span");
    status.append(message);
    status.dataset.pendingLabel = strings.updating ?? "Updating…";
    const preview = element("div");
    preview.className = "st-comparison-preview";
    preview.setAttribute("aria-label", strings.previewLabel ?? "Change preview");
    const panes = (["baseline", "working"] as const).map(side => {
        const heading = element("h3");
        const section = side === "baseline" ? referencePane : workingPane;
        section.prepend(heading);
        const excerpt = element("pre");
        preview.append(excerpt);
        return { side, heading, excerpt };
    });
    const previewHint = element("span");
    previewHint.textContent = strings.selectChange ?? "Select a changed line to preview it.";
    preview.append(previewHint);
    comparison.element.prepend(controls);
    comparison.element.append(preview);
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    const visible = (value: string) => value.replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\r", "␍").replaceAll("\n", "↵\n");
    let rendered: TextComparisonSnapshot | undefined, hasCompletedResult = false;
    function render(): void {
        const current = comparison.getSnapshot(), old = rendered;
        // Cursor counters do not change this control surface or its bounded preview.
        if (old && old.comparison.generation === current.comparison.generation && old.comparison.status === current.comparison.status
            && sameControlState(old, current)) return;
        rendered = current;
        const { comparison: state, selectedHunk: selected, canNavigate, canRevert, scrollLinked, alignment: layout, disposed } = current;
        const count = state.hunks.length, hunk = selected === null ? undefined : state.hunks[selected];
        const total = count.toLocaleString();
        const position = selected === null ? undefined : `${(selected + 1).toLocaleString()} of ${total}`;
        link.checked = scrollLinked; align.checked = layout.enabled; link.disabled = align.disabled = disposed || !state.baseline || !state.working;
        previous.disabled = next.disabled = !canNavigate; revert.disabled = !canRevert;
        revert.title = strings.restoreHint?.(current)
            ?? (position ? `Restore change ${position} from the baseline` : "Place the caret in a change");
        for (const { heading, side } of panes) {
            setText(heading, strings.heading?.(side, current) ?? (side === "baseline"
                ? state.baseline ? `Baseline · ${state.baseline.version}` : "Baseline unavailable"
                : state.working ? `Working · revision ${state.working.revision}` : "Working unavailable"));
        }
        // A new reference or a break in the edit history cannot reuse the previous preview.
        // Buttons above already reflect the live command guards, including during a short edit.
        const retainResult = hasCompletedResult && state.status === "running" && old !== undefined && state.baseline === old.comparison.baseline
            && state.working?.change != null && (state.generation === old.comparison.generation
                || state.working.change.previousRevision === old.comparison.working?.revision);
        controls.toggleAttribute("data-updating", retainResult);
        align.title = layout.pending ? strings.preparingRows ?? "Preparing aligned rows" : "";
        if (retainResult) {
            status.setAttribute("aria-busy", "true");
            preview.title = strings.lastCompleted ?? "Last completed comparison";
            return;
        }
        status.removeAttribute("aria-busy"); preview.removeAttribute("title");
        hasCompletedResult = state.status === "ready";
        const described = hunk ?? (count === 1 ? state.hunks[0] : undefined);
        const detail = described?.lineEndingOnly ? " · line endings only" : described?.whitespaceOnly ? " · whitespace only" : "";
        const summary = position ? `Change ${position}` : count ? `${total} ${count === 1 ? "change" : "changes"}` : "No changes";
        const result = state.status === "ready" ? summary + detail : state.failure ?? `Comparison ${state.status}`;
        setText(message, strings.statusText?.(current) ?? result + (layout.status === "failed" ? " · row alignment unavailable" : ""));
        preview.hidden = state.status !== "ready" || count === 0;
        previewHint.hidden = !!hunk;
        if (old?.selectedHunk !== selected) { preview.scrollTop = 0; preview.scrollLeft = 0; }
        for (const { side, excerpt } of panes) {
            excerpt.hidden = !hunk;
            const source = state[side];
            if (!hunk || !source) {
                setText(excerpt, "");
                continue;
            }
            const range = hunk[side];
            const first = range.lineFrom + 1;
            const lines = first === range.lineTo ? `line ${first}` : `lines ${first}–${range.lineTo}`;
            const text = visible(textExcerpt(source.buffer, 160, "…", range.from, range.to));
            const fallback = range.from === range.to
                ? side === "baseline" ? "Baseline: no text removed" : "Working: no text added"
                : `${side === "baseline" ? "Baseline" : "Working"} ${lines}: ${text}`;
            setText(excerpt, strings.excerpt?.(side, range, text) ?? fallback);
        }
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
    render();
    const stop = comparison.subscribe(render);
    return () => {
        stop();
        listeners.abort();
        controls.remove();
        preview.remove();
        for (const { heading } of panes) heading.remove();
    };
}
