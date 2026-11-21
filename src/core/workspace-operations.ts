import type { NotificationScope } from "./observable.ts";
import type { SnapshotValue } from "./values.ts";
import { surfaceResource } from "./workspace-tabs.ts";
import type { LoadOperation, Operation, ResourceHandle, ResourceId, TabTarget, Workspace } from "./workspace.ts";

export type WorkspaceOperations = Readonly<{
    begin: (id: ResourceId, lane: string | symbol, presentation?: TabTarget) => Operation;
    beginLoad: <T extends SnapshotValue>(handle: ResourceHandle<T>) => LoadOperation<T>;
}>;

/** Hosts can run one current request per resource and lane, with an optional tab-generation guard. */
export function createWorkspaceOperations(workspace: Workspace, scope: NotificationScope, beginLoad: WorkspaceOperations["beginLoad"]): WorkspaceOperations {
    const resources = new WeakMap<ResourceHandle<SnapshotValue>, { lanes: Map<string | symbol, Operation>; serial: number }>();
    function begin(id: ResourceId, lane: string | symbol, presentation?: TabTarget): Operation {
        scope.assertWritable();
        if (presentation !== undefined) {
            const tab = workspace.tabs.resolve(presentation);
            if (!tab || surfaceResource(workspace, tab.surface) !== id) throw new Error("Operation presentation does not own this resource.");
        }
        const resource = workspace.resource(id), target = workspace.captureResource(id), lease = workspace.acquire(id);
        let requests = resources.get(resource);
        if (!requests) { requests = { lanes: new Map(), serial: 0 }; resources.set(resource, requests); }
        const { lanes } = requests;
        lanes.get(lane)?.cancel();
        let cancelled = false, finished = false;
        const operation: Operation = Object.freeze({
            target, revision: resource.getSnapshot().revision, generation: ++requests.serial,
            isCurrent: () => !cancelled && !finished && lanes.get(lane) === operation && workspace.resolveResource(target) === resource,
            isCancelled: () => cancelled,
            presentationCurrent: () => operation.isCurrent() && (presentation === undefined || workspace.tabs.resolve(presentation) !== undefined),
            cancel: () => { scope.assertWritable(); cancelled = true; },
            finish: () => {
                scope.assertWritable();
                if (finished) return;
                finished = true; lease.release();
                if (lanes.get(lane) === operation) lanes.delete(lane);
            }
        });
        lanes.set(lane, operation); return operation;
    }
    return Object.freeze({ begin, beginLoad });
}
