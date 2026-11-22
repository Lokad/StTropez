import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import type { ViewState } from "./view-state.ts";

export type NavigationOrigin = Readonly<{ visit: (open: () => boolean) => boolean }>;
export type NavigationHistory = Observable<number> & Readonly<{
    capture: (editor: TextEditor) => NavigationOrigin | undefined;
    back: (present: (view: DocumentView) => TextEditor | "busy" | undefined, options?: Readonly<{ focus?: boolean }>) => "restored" | "busy" | "empty";
    dispose: () => void;
}>;
type Entry = { view: DocumentView; tab: TabTarget | undefined; state: ViewState };

/** The host presents destinations. Only successful visits enter this workspace's Return history. */
export function createNavigationHistory(workspace: Workspace): NavigationHistory {
    const scope = workspace.createNotificationScope(), depth = new Store(0, scope);
    const entries: Entry[] = [];
    let disposed = false, navigating = false;
    const owns = (entry: Entry) => ownsTextSurface(workspace, entry.view, entry.tab);
    function busy(editor: TextEditor) {
        const state = editor.activity();
        return state.composing || state.pendingCommand || state.pendingInput;
    }
    function capture(editor: TextEditor): NavigationOrigin | undefined {
        const { view, tab, signal } = editor;
        if (disposed || signal.aborted || !editor.element.isConnected || !ownsTextSurface(workspace, view, tab) || busy(editor)) return;
        const entry = { view, tab, state: editor.captureView() }, revision = view.getSnapshot().revision;
        return Object.freeze({ visit(open: () => boolean) {
            if (disposed || navigating || signal.aborted || !editor.element.isConnected || !owns(entry)
                || view.getSnapshot().revision !== revision || busy(editor)) return false;
            scope.assertWritable(); navigating = true;
            try {
                if (!open()) return false;
                if (!disposed && owns(entry) && entries.at(-1) !== entry) {
                    entries.push(entry);
                    if (entries.length > 100) entries.shift();
                    scope.publish(depth, entries.length);
                }
                return true;
            } finally { navigating = false; }
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
                if (!owns(entry)) { entries.pop(); continue; }
                const editor = present(entry.view);
                if (disposed) return "empty";
                if (editor === "busy") return "busy";
                if (editor?.view === entry.view && !editor.signal.aborted && editor.element.isConnected
                    && owns(entry) && ownsTextSurface(workspace, editor.view, editor.tab)) {
                    if (busy(editor)) return "busy";
                    if (editor.restoreView(entry.state)) {
                        entries.pop();
                        if (focus) editor.focus();
                        return "restored";
                    }
                }
                entries.pop();
            }
            return "empty";
        } finally { navigating = false; scope.publish(depth, entries.length); }
    }, dispose() { scope.assertWritable(); disposed = true; entries.length = 0; scope.publish(depth, 0); } });
}
