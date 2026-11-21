import type { TextComparison, TextComparisonSnapshot } from "../../src/browser/index.ts";

/** A host-owned control surface outside the comparison's DOM subtree. */
export function mountReviewControls(host: HTMLElement, comparison: TextComparison): () => void {
    const owner = host.ownerDocument, controls = owner.createElement("nav"), listeners = new AbortController();
    controls.setAttribute("aria-label", "Custom review commands");
    const button = (label: string) => { const element = owner.createElement("button"); element.type = "button"; element.textContent = label; controls.append(element); return element; };
    const previous = button("Earlier change"), next = button("Later change"), revert = button("Restore selected change");
    const alignment = button("Toggle aligned rows"), linking = button("Toggle linked scrolling"), status = owner.createElement("output");
    controls.append(status); host.append(controls);
    function render(): void {
        const state = comparison.getSnapshot(), selected = state.selectedHunk;
        previous.disabled = next.disabled = !state.canNavigate; revert.disabled = !state.canRevert;
        revert.title = selected === null ? "Place the caret in a change" : `Restore change ${selected + 1} of ${state.comparison.hunks.length}`;
        alignment.disabled = linking.disabled = state.disposed || !state.comparison.baseline || !state.comparison.working;
        alignment.setAttribute("aria-pressed", String(state.alignment.enabled)); linking.setAttribute("aria-pressed", String(state.scrollLinked));
        status.textContent = `${state.comparison.status}: ${selected === null ? "no change selected" : `change ${selected + 1} of ${state.comparison.hunks.length}`} · alignment ${state.alignment.status}`;
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
    alignment.addEventListener("click", () => comparison.setRowsAligned(!comparison.getSnapshot().alignment.enabled), { signal: listeners.signal });
    linking.addEventListener("click", () => comparison.setScrollLinked(!comparison.getSnapshot().scrollLinked), { signal: listeners.signal });
    const stop = comparison.subscribe(render); render();
    return () => { stop(); listeners.abort(); controls.remove(); };
}
