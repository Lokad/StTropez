import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import type { ViewState } from "./view-state.ts";
import { mapViewAnchor } from "./view-state.ts";
import { createSelectionSet } from "../core/selections.ts";

export type NavigationOrigin = Readonly<{ viewState: ViewState; visit: (open: () => boolean) => boolean }>;
export type NavigationHistory = Observable<number> & Readonly<{
    capture: (editor: TextEditor, pointedOffset?: number) => NavigationOrigin | undefined;
    back: (present: (view: DocumentView) => TextEditor | "busy" | undefined, options?: Readonly<{ focus?: boolean }>) => "restored" | "busy" | "empty";
    dispose: () => void;
}>;
type Entry = { view: DocumentView; tab: TabTarget | undefined; origin: ViewState; state: ViewState; revision: number; stop: () => void };

/** The host presents destinations. Only successful visits enter this workspace's Return history. */
export function createNavigationHistory(workspace: Workspace): NavigationHistory {
    const scope = workspace.createNotificationScope(), depth = new Store(0, scope);
    const entries: Entry[] = [];
    let disposed = false, navigating = false;
    const owns = (entry: Entry) => workspace.ownsDocumentView(entry.view, entry.tab);
    function live(editor: TextEditor) {
        return !disposed && !editor.signal.aborted && editor.element.isConnected
            && workspace.ownsDocumentView(editor.view, editor.tab);
    }
    function busy(editor: TextEditor) {
        const state = editor.activity();
        return state.input !== "idle";
    }
    function track(view: DocumentView, tab: TabTarget | undefined, origin: ViewState, revision: number): Entry {
        const entry: Entry = { view, tab, origin, state: origin, revision, stop: workspace.onDocumentChange(view.documentId, change => {
            if (entry.revision !== change.previousRevision) return;
            const { state } = entry;
            const selections = change.mapSelections(state.selectionSet ?? { ranges: [state], primary: 0 });
            const horizontalAnchor = mapViewAnchor(state.horizontalAnchor, change.revision, change);
            const verticalAnchor = mapViewAnchor(state.verticalAnchor, change.revision, change);
            entry.revision = change.revision;
            entry.state = { ...selections.ranges[selections.primary]!, selectionSet: selections, scrollLeft: state.scrollLeft,
                scrollTop: state.scrollTop, ...(horizontalAnchor && { horizontalAnchor }), ...(verticalAnchor && { verticalAnchor }) };
        }) };
        return entry;
    }
    function capture(editor: TextEditor, pointedOffset?: number): NavigationOrigin | undefined {
        const { view, tab } = editor;
        if (!live(editor) || busy(editor)) return;
        let state = editor.captureView();
        if (pointedOffset !== undefined) {
            const set = createSelectionSet(workspace.document(view.documentId).buffer.length, [{ anchor: pointedOffset, head: pointedOffset }]);
            if (state.anchor === state.head && pointedOffset !== state.head && (state.selectionSet?.ranges.length ?? 1) === 1)
                state = Object.freeze({ ...state, ...set.ranges[0]!, selectionSet: set });
        }
        const revision = view.getSnapshot().revision;
        return Object.freeze({ viewState: state, visit(open: () => boolean) {
            if (navigating || !live(editor) || view.getSnapshot().revision !== revision || busy(editor)) return false;
            scope.assertWritable(); navigating = true;
            let entry: Entry | undefined;
            try {
                if (entries.at(-1)?.origin !== state) entry = track(view, tab, state, revision);
                if (!open()) return false;
                if (entry && !disposed && owns(entry)) {
                    entries.push(entry);
                    entry = undefined;
                    if (entries.length > 100) entries.shift()!.stop();
                    scope.publish(depth, entries.length);
                }
                return true;
            } finally { entry?.stop(); navigating = false; }
        } });
    }
    return Object.freeze({ ...depth.observable, capture, back(present, { focus = false } = {}) {
        if (typeof focus !== "boolean") throw new TypeError("Invalid navigation focus option.");
        if (disposed) return "empty";
        if (navigating) return "busy";
        scope.assertWritable(); navigating = true;
        try {
            while (entries.length) {
                const entry = entries[entries.length - 1]!;
                const editor = owns(entry) ? present(entry.view) : undefined;
                if (disposed) return "empty";
                if (editor === "busy") return "busy";
                if (editor?.view === entry.view && live(editor) && owns(entry)) {
                    if (busy(editor)) return "busy";
                    if (entry.revision === entry.view.getSnapshot().revision && editor.restoreView(entry.state)) {
                        entries.pop()!.stop();
                        if (focus) editor.focus();
                        return "restored";
                    }
                }
                entries.pop()!.stop();
            }
            return "empty";
        } finally { navigating = false; scope.publish(depth, entries.length); }
    }, dispose() { scope.assertWritable(); disposed = true; for (const entry of entries.splice(0)) entry.stop(); scope.publish(depth, 0); } });
}
