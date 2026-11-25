import type { TextComparison, TextEditor } from "../../src/browser/index.ts";

/** Hide the saved pane without replacing either editor or giving the hidden pane control of scrolling. */
export function reviewLayout(surface: HTMLElement, review: TextComparison) {
    const { reference, working } = review.panes;
    function hide() {
        const state = review.getSnapshot(), active = review.activePane();
        const saved = reference.captureView(), source = working.captureView();
        review.setScrollLinked(false); review.setRowsAligned(false);
        surface.classList.add("demo-working-only");
        working.viewport.flush();
        return {
            active, saved, source, baseline: state.comparison.baseline,
            linked: state.scrollLinked, aligned: state.alignment.enabled,
            hiddenSource: working.captureView(), folds: working.view.folding.getSnapshot(),
        };
    }
    let hidden: ReturnType<typeof hide> | undefined;
    return (collapse: boolean): TextEditor => {
        if (collapse) { hidden ??= hide(); return working; }
        if (!hidden) return review.activePane();
        const previous = hidden; hidden = undefined;
        const current = working.captureView(), initial = previous.hiddenSource;
        const folds = working.view.folding.getSnapshot();
        const sameSource = folds.revision === previous.folds.revision && current.selectionSet === initial.selectionSet
            && current.scrollTop === initial.scrollTop && current.scrollLeft === initial.scrollLeft
            && folds.index.sameProjection(previous.folds.index);
        const sameReference = review.getSnapshot().comparison.baseline === previous.baseline;
        surface.classList.remove("demo-working-only");
        review.setRowsAligned(previous.aligned); review.setScrollLinked(previous.linked);
        working.restoreView(sameSource ? previous.source : current);
        if (sameReference) reference.restoreView(previous.saved);
        working.viewport.flush(); reference.viewport.flush();
        return sameSource && sameReference ? previous.active : working;
    };
}
