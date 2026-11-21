import type { TextComparison, TextComparisonSnapshot } from "./comparison.ts";

/** Optional presentation. Pane ownership and command validation stay with the comparison. */
export function mountComparisonControls(
    comparison: Pick<TextComparison, "element" | "getSnapshot" | "subscribe" | "navigateHunk" | "revertSelectedHunk" | "setScrollLinked" | "setRowsAligned">,
    referencePane: HTMLElement, workingPane: HTMLElement
): () => void {
    const owner = comparison.element.ownerDocument, controls = owner.createElement("div"), listeners = new AbortController();
    controls.className = "st-comparison-controls";
    const button = (label: string) => { const result = owner.createElement("button"); result.type = "button"; result.textContent = label; controls.append(result); return result; };
    const previous = button("Previous change"), next = button("Next change"), revert = button("Use baseline");
    previous.title = "Previous change (Shift+F7)"; next.title = "Next change (F7)";
    const checkbox = (label: string) => {
        const wrapper = owner.createElement("label"), input = owner.createElement("input"); input.type = "checkbox";
        wrapper.append(input, ` ${label}`); controls.append(wrapper); return input;
    };
    const link = checkbox("Link review scrolling"), align = checkbox("Align review rows"), status = owner.createElement("output"); controls.append(status);
    const referenceHeading = owner.createElement("h3"), workingHeading = owner.createElement("h3");
    referencePane.prepend(referenceHeading); workingPane.prepend(workingHeading);
    const preview = owner.createElement("div"), referencePreview = owner.createElement("pre"), workingPreview = owner.createElement("pre");
    preview.className = "st-comparison-preview"; preview.setAttribute("aria-label", "Selected change with visible whitespace");
    preview.append(referencePreview, workingPreview); comparison.element.prepend(controls); comparison.element.append(preview);
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    const visible = (value: string) => value.replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\r", "␍").replaceAll("\n", "↵\n");
    let rendered: TextComparisonSnapshot | undefined;
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
        link.checked = scrollLinked; align.checked = layout.enabled; link.disabled = align.disabled = disposed || !state.baseline || !state.working;
        previous.disabled = next.disabled = !canNavigate; revert.disabled = !canRevert;
        revert.title = selected === null ? "Place the caret in a change" : `Restore change ${selected + 1} of ${count} from the baseline`;
        setText(referenceHeading, state.baseline ? `Baseline · ${state.baseline.version}` : "Baseline unavailable");
        setText(workingHeading, state.working ? `Working · revision ${state.working.revision}` : "Working unavailable");
        const described = hunk ?? (count === 1 ? state.hunks[0] : undefined);
        const detail = described?.lineEndingOnly ? " · line endings only" : described?.whitespaceOnly ? " · whitespace only" : "";
        const message = state.status === "ready" ? count ? (hunk ? `Change ${selected! + 1} of ${count}` : count === 1 ? "1 change" : `${count} changes`) + detail : "No changes" : state.failure ?? `Comparison ${state.status}`;
        setText(status, message + (layout.pending ? " · preparing aligned rows" : layout.status === "failed" ? " · row alignment unavailable" : ""));
        preview.hidden = !hunk;
        if (hunk && state.baseline && state.working) {
            const text = (side: "baseline" | "working") => {
                const range = hunk[side], buffer = side === "baseline" ? state.baseline!.buffer : state.working!.buffer;
                return `${side === "baseline" ? "Baseline" : "Working"} lines ${range.lineFrom + 1}–${Math.max(range.lineFrom + 1, range.lineTo)}: ${range.from === range.to ? "∅" : visible(buffer.slice(range.from, Math.min(range.to, range.from + 160))) + (range.to - range.from > 160 ? "…" : "")}`;
            };
            setText(referencePreview, text("baseline")); setText(workingPreview, text("working"));
        } else { setText(referencePreview, ""); setText(workingPreview, ""); }
    }
    previous.addEventListener("click", () => comparison.navigateHunk(-1), { signal: listeners.signal });
    next.addEventListener("click", () => comparison.navigateHunk(1), { signal: listeners.signal });
    let press: TextComparisonSnapshot | null | undefined;
    revert.addEventListener("pointerdown", () => { press = comparison.getSnapshot(); }, { signal: listeners.signal });
    revert.addEventListener("keydown", event => { if (!event.repeat && (event.key === " " || event.key === "Enter")) press = comparison.getSnapshot(); }, { signal: listeners.signal });
    revert.addEventListener("pointercancel", () => { press = undefined; }, { signal: listeners.signal });
    revert.addEventListener("blur", () => { if (press) press = null; }, { signal: listeners.signal });
    revert.addEventListener("click", event => {
        const shown = event.isTrusted ? press : undefined; press = undefined;
        if (shown !== null) comparison.revertSelectedHunk(shown);
    }, { signal: listeners.signal });
    link.addEventListener("change", () => comparison.setScrollLinked(link.checked), { signal: listeners.signal });
    align.addEventListener("change", () => comparison.setRowsAligned(align.checked), { signal: listeners.signal });
    const stop = comparison.subscribe(render); render();
    return () => { stop(); listeners.abort(); controls.remove(); preview.remove(); referenceHeading.remove(); workingHeading.remove(); };
}
