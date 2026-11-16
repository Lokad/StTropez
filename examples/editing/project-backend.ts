import type { DocumentSnapshot } from "../../src/index.ts";
import type { LspCommandScope } from "../../src/protocol/index.ts";
import type { ProjectCommand, ProjectOutcome, ProjectServerRequest } from "../../fixtures/language/project-commands.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";
import type { ProviderBackend } from "../shared/provider-lane.ts";
import { createNavigationClient } from "./navigation-client.ts";
import type { NavigationMetrics } from "./navigation-client.ts";
import type { LspProjectClient, LspProjectFactory } from "./lsp-project-client.ts";

type ProjectRequest = Readonly<{ input: ProjectCommand; documents: readonly DocumentSnapshot[];
    accept: (request: ProjectServerRequest) => ProjectOutcome; scope: LspCommandScope }>;
type ProjectResult = ProjectOutcome & Readonly<{ registered: boolean }>;
export type ProjectBackend =
    | ProviderBackend<ProjectRequest, ProjectResult, ReturnType<LspProjectClient["snapshot"]>> & Readonly<{ kind: "lsp"; isCurrent: () => boolean }>
    | ProviderBackend<ProjectRequest, ProjectResult, ReturnType<ReturnType<typeof createNavigationClient>["snapshot"]>> & Readonly<{ kind: "worker" }>;

/** Host decision callbacks remain synchronous for workers and scoped/async for LSP. */
export function createProjectBackend(clock: Pick<Window, "setTimeout" | "clearTimeout">, metrics: NavigationMetrics,
    factory: LspProjectFactory | undefined, changed: () => void): ProjectBackend {
    if (factory) {
        const client = factory(), cleanup = new CleanupScope(); cleanup.defer(client.dispose);
        try {
            cleanup.defer(client.subscribe(changed));
            return Object.freeze({ kind: "lsp" as const,
                run: ({ input, scope }: ProjectRequest) => client.run(input, scope), isCurrent: client.isCurrent,
                cancel: cleanup.dispose, dispose: cleanup.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
            });
        } catch (error) { cleanup.rollback(error); }
    }
    const client = createNavigationClient(clock, metrics, undefined, changed);
    return Object.freeze({ kind: "worker" as const,
        run: ({ input, documents, accept }: ProjectRequest) => client.command(input, new Map(documents.map(document => [document.id, document.buffer])), accept),
        // Cancelling an uncertain command ends its connection; the host drops its lane.
        cancel: client.dispose, dispose: client.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
    });
}
