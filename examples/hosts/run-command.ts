import type { Immutable, ResourceHandle, ResourceKey, ResourceTarget, SnapshotValue, Workspace } from "../../src/index.ts";

export type RunSettings = Readonly<{ mode: "preview" | "inspect" }>;
type RunResource<T> = Readonly<{ target: ResourceTarget; key: ResourceKey; revision: number; value: Immutable<T>; serverVersion: string | null }>;
export type RunSubmission<S, C> = Readonly<{ source: RunResource<S>; configuration: RunResource<C>; settings: RunSettings }>;

function capture<T extends SnapshotValue>(workspace: Workspace, resource: ResourceHandle<T>): RunResource<T> {
    if (workspace.resource(resource.id) !== resource) throw new Error("Run resource belongs to another workspace.");
    const state = resource.getSnapshot();
    if (state.state !== "ready") throw new Error("Run resource is unavailable.");
    return Object.freeze({ target: workspace.captureResource(resource.id), key: state.metadata.key, revision: state.revision,
        value: state.value(), serverVersion: state.metadata.serverVersion });
}

export async function runWithResources<S extends SnapshotValue, C extends SnapshotValue, R>(
    workspace: Workspace, source: ResourceHandle<S>, configuration: ResourceHandle<C>, settings: RunSettings,
    submit: (input: RunSubmission<S, C>) => Promise<R>,
): Promise<R> {
    const input = Object.freeze({ source: capture(workspace, source), configuration: capture(workspace, configuration),
        settings: Object.freeze({ mode: settings.mode }) });
    const sourceLease = workspace.acquire(source.id);
    try {
        const configurationLease = workspace.acquire(configuration.id);
        try { return await submit(input); }
        finally { configurationLease.release(); }
    } finally { sourceLease.release(); }
}
