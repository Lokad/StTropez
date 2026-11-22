import type { Workspace } from "../core/workspace.ts";
import { LspWorkspace, type LspWorkspaceOptions } from "../protocol/lsp-workspace.ts";
import type { RpcScheduler, RpcTransport } from "../protocol/json-rpc.ts";

export type BrowserLspWorkspaceOptions = Omit<LspWorkspaceOptions, "connect" | "schedule"> & Readonly<{
    connect: (signal: AbortSignal) => Promise<RpcTransport>;
    schedule?: RpcScheduler;
}>;

const scheduleTimeout: RpcScheduler = (delay, callback) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
};

/** Shares the protocol workspace's bindings and scopes. Each transport opening gets its own signal. */
export class BrowserLspWorkspace extends LspWorkspace {
    constructor(workspace: Workspace, options: BrowserLspWorkspaceOptions) {
        super(workspace, {
            ...options,
            schedule: options.schedule ?? scheduleTimeout,
            async connect(context) {
                const abort = new AbortController();
                const stop = context.onCancel(() => abort.abort());
                try {
                    return await options.connect(abort.signal);
                } finally {
                    stop();
                }
            },
        });
    }
}
