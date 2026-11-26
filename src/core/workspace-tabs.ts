import { emptyList } from "./empty-list.ts";
import { Store } from "./observable.ts";
import type { NotificationScope, Observable } from "./observable.ts";
import type { PaneId, ResourceId, Surface, TabId, TabSnapshot, TabTarget, Workspace } from "./workspace.ts";

export type WorkspaceTabs = Observable<readonly TabSnapshot[]> & Readonly<{
    open: (surface: Surface, pane: PaneId) => TabId;
    move: (id: TabId, pane: PaneId) => void;
    replace: (id: TabId, surface: Surface) => void;
    close: (id: TabId) => void;
    capture: (id: TabId) => TabTarget;
    resolve: (target: TabTarget) => TabSnapshot | undefined;
}>;

export function surfaceResource(workspace: Workspace, surface: Surface): ResourceId {
    return surface.kind === "text" ? workspace.resourceForDocument(surface.documentId).id : surface.resourceId;
}

/** A workspace allocates its tab inventory only when a host asks for it. */
export function createWorkspaceTabs(workspace: Workspace, scope: NotificationScope, lifetime: symbol,
    publish: (changed: Set<Store<unknown>>) => void, release: (resourceId: ResourceId) => void) {
    let visible: readonly TabSnapshot[] = emptyList, serial = 0;
    const all = new Store(visible, scope), index = new Map<TabId, TabSnapshot>();
    function requireTab(id: TabId): TabSnapshot {
        const tab = index.get(id);
        if (!tab) throw new Error("Unknown tab.");
        return tab;
    }
    function publishTabs(tabs: TabSnapshot[]): void {
        const next = Object.freeze(tabs), listed = next.filter(tab => tab.visibility === "workspace");
        if (listed.length !== visible.length || listed.some((tab, i) => tab !== visible[i]))
            visible = listed.length === next.length ? next : Object.freeze(listed);
        index.clear();
        for (const tab of tabs) index.set(tab.id, tab);
        const changed = new Set<Store<unknown>>(); all.set(next, changed); publish(changed);
    }
    function close(id: TabId): void {
        scope.assertWritable();
        const previous = surfaceResource(workspace, requireTab(id).surface);
        publishTabs(all.get().filter(tab => tab.id !== id)); release(previous);
    }
    const capture = (id: TabId): TabTarget => Object.freeze({ workspace: lifetime, id, generation: requireTab(id).generation });
    const resolve = (target: TabTarget): TabSnapshot | undefined => {
        const tab = target.workspace === lifetime ? index.get(target.id) : undefined;
        return tab?.generation === target.generation ? tab : undefined;
    };
    const api: WorkspaceTabs = Object.freeze({
        getSnapshot: () => visible, subscribe: all.observable.subscribe, capture, resolve, close,
        open(surface: Surface, paneId: PaneId) {
            scope.assertWritable();
            const visibility = workspace.resource(surfaceResource(workspace, surface)).metadata.getSnapshot().visibility;
            const id = `tab-${++serial}` as TabId;
            publishTabs([...all.get(), Object.freeze({ id, paneId, generation: 0, surface: Object.freeze({ ...surface }), visibility })]); return id;
        },
        move(id: TabId, paneId: PaneId) {
            scope.assertWritable();
            if (requireTab(id).paneId !== paneId) publishTabs(all.get().map(tab => tab.id === id ? Object.freeze({ ...tab, paneId }) : tab));
        },
        replace(id: TabId, surface: Surface) {
            scope.assertWritable();
            const previous = surfaceResource(workspace, requireTab(id).surface);
            const visibility = workspace.resource(surfaceResource(workspace, surface)).metadata.getSnapshot().visibility;
            publishTabs(all.get().map(tab => tab.id === id ? Object.freeze({ ...tab, generation: tab.generation + 1, surface: Object.freeze({ ...surface }), visibility }) : tab));
            release(previous);
        },
    });
    return { api, count: (resource?: ResourceId) => resource === undefined ? index.size
        : all.get().filter(tab => surfaceResource(workspace, tab.surface) === resource).length };
}
