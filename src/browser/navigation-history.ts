import { isMountedEditor } from "./captured-view.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import type { ViewState } from "./view-state.ts";
import { mapViewAnchor } from "./view-state.ts";
import { createSelectionSet } from "../core/selections.ts";

export type NavigationOrigin = Readonly<{ viewState: ViewState; visit: (open: () => boolean) => boolean }>;
type Depths = Readonly<{ back: number; forward: number }>;
type Travel = (
    current: TextEditor | undefined,
    present: (view: DocumentView) => TextEditor | "busy" | undefined,
    options?: Readonly<{ focus?: boolean }>,
) => "restored" | "busy" | "empty";
export type NavigationHistory = Observable<Depths> & Readonly<{
    capture: (editor: TextEditor, pointedOffset?: number) => NavigationOrigin | undefined;
    back: Travel;
    forward: Travel;
    dispose: () => void;
}>;
type Entry = { view: DocumentView; tab: TabTarget | undefined; origin: ViewState; state: ViewState; revision: number; stop: () => void };

/** Keep successful jumps and map the saved positions through document changes. */
export function createNavigationHistory(workspace: Workspace): NavigationHistory {
    const scope = workspace.createNotificationScope();
    const depths = new Store<Depths>(Object.freeze({ back: 0, forward: 0 }), scope);
    const back: Entry[] = [];
    const forward: Entry[] = [];
    let disposed = false, navigating = false;

    function publish() {
        const previous = depths.get();
        if (previous.back !== back.length || previous.forward !== forward.length) {
            scope.publish(depths, Object.freeze({ back: back.length, forward: forward.length }));
        }
    }
    function clear(stack: Entry[]) {
        for (const entry of stack.splice(0)) entry.stop();
    }
    const owns = (entry: Entry) => workspace.ownsDocumentView(entry.view, entry.tab);
    function live(editor: TextEditor) {
        return !disposed && isMountedEditor(editor, workspace);
    }
    function busy(editor: TextEditor) {
        const state = editor.activity();
        return state.input !== "idle";
    }
    function track({ view, tab }: TextEditor, origin: ViewState, revision: number): Entry {
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
        const { view } = editor;
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
                if (back.at(-1)?.origin !== state) entry = track(editor, state, revision);
                if (!open()) return false;
                clear(forward);
                if (entry && !disposed && owns(entry)) {
                    back.push(entry);
                    entry = undefined;
                    if (back.length > 100) back.shift()!.stop();
                }
                publish();
                return true;
            } finally { entry?.stop(); navigating = false; }
        } });
    }
    function travel(from: Entry[], to: Entry[]): Travel {
        return (current, present, { focus = false } = {}) => {
            if (typeof focus !== "boolean") throw new TypeError("Invalid navigation focus option.");
            if (disposed) return "empty";
            if (navigating || current && (!live(current) || busy(current))) return "busy";
            scope.assertWritable();
            navigating = true;
            let departure: Entry | undefined;
            try {
                while (from.length) {
                    const target = from.at(-1)!;
                    if (!owns(target)) {
                        from.pop()!.stop();
                        continue;
                    }
                    // Presenting another file may dispose the editor we are leaving.
                    if (current) departure = track(current, current.captureView(), current.view.getSnapshot().revision);
                    const editor = present(target.view);
                    if (disposed) return "empty";
                    if (!editor || editor === "busy" || editor.view !== target.view || !live(editor) || busy(editor)
                        || !owns(target) || target.revision !== target.view.getSnapshot().revision
                        || !editor.restoreView(target.state)) return "busy";
                    if (disposed) return "empty";
                    from.pop()!.stop();
                    if (departure && owns(departure)) {
                        to.push(departure);
                        departure = undefined;
                    }
                    if (focus) editor.focus();
                    return "restored";
                }
                return "empty";
            } finally {
                departure?.stop();
                navigating = false;
                publish();
            }
        };
    }
    return Object.freeze({
        ...depths.observable, capture, back: travel(back, forward), forward: travel(forward, back),
        dispose() {
            scope.assertWritable();
            disposed = true;
            clear(back);
            clear(forward);
            publish();
        },
    });
}
