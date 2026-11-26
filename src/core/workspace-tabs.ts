import { Store } from "./observable.ts";
import type { NotificationScope, Observable } from "./observable.ts";
import type { ResourceId, Surface, TabId, TabSnapshot, TabTarget, Workspace } from "./workspace.ts";

export type WorkspaceTabs = Pick<Observable<unknown>, "subscribe"> & Readonly<{
    open: (surface: Surface) => TabId;
    replace: (id: TabId, surface: Surface) => void;
    close: (id: TabId) => void;
    capture: (id: TabId) => TabTarget;
    resolve: (target: TabTarget) => TabSnapshot | undefined;
}>;

export function surfaceResource(workspace: Workspace, surface: Surface): ResourceId {
    return surface.kind === "text" ? workspace.resourceForDocument(surface.documentId).id : surface.resourceId;
}

export function createWorkspaceTabs(workspace: Workspace, scope: NotificationScope, lifetime: symbol,
    publish: (changed: Set<Store<unknown>>) => void, release: (resourceId: ResourceId) => void) {
    const changes = new Store(undefined, scope);
    const index = new Map<TabId, TabSnapshot>();
    let serial = 0;
    function requireTab(id: TabId): TabSnapshot {
        const tab = index.get(id);
        if (!tab) throw new Error("Unknown tab.");
        return tab;
    }
    function set(id: TabId, generation: number, surface: Surface) {
        workspace.resource(surfaceResource(workspace, surface));
        index.set(id, Object.freeze({ id, generation, surface: Object.freeze({ ...surface }) }));
        publish(new Set([changes]));
    }
    const api: WorkspaceTabs = Object.freeze({
        subscribe: changes.observable.subscribe,
        capture(id) {
            return Object.freeze({ workspace: lifetime, id, generation: requireTab(id).generation });
        },
        resolve(target) {
            const tab = target.workspace === lifetime ? index.get(target.id) : undefined;
            return tab?.generation === target.generation ? tab : undefined;
        },
        open(surface) {
            scope.assertWritable();
            const id = `tab-${++serial}` as TabId;
            set(id, 0, surface);
            return id;
        },
        replace(id, surface) {
            scope.assertWritable();
            const tab = requireTab(id);
            const previous = surfaceResource(workspace, tab.surface);
            set(id, tab.generation + 1, surface);
            release(previous);
        },
        close(id) {
            scope.assertWritable();
            const previous = surfaceResource(workspace, requireTab(id).surface);
            index.delete(id);
            publish(new Set([changes]));
            release(previous);
        },
    });
    return { api, count(resource?: ResourceId) {
        if (resource === undefined) return index.size;
        let count = 0;
        for (const tab of index.values()) if (surfaceResource(workspace, tab.surface) === resource) count++;
        return count;
    } };
}
