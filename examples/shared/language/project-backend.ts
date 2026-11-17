import type { LspCommandScope } from "../../../src/protocol/index.ts";
import type { ProjectCommand, ProjectOutcome } from "../../../fixtures/language/project-commands.ts";
import { CleanupScope } from "../cleanup-scope.ts";
import type { ProviderBackend } from "../provider-lane.ts";
import type { LspProjectClient, LspProjectFactory } from "./lsp-project-client.ts";

type ProjectRequest = Readonly<{ input: ProjectCommand; scope: LspCommandScope }>;
type ProjectResult = ProjectOutcome & Readonly<{ registered: boolean }>;
export type ProjectBackend =
    ProviderBackend<ProjectRequest, ProjectResult, ReturnType<LspProjectClient["snapshot"]>> & Readonly<{ isCurrent: () => boolean }>;

/** Captured commands retain the LSP client and its host review scope. */
export function createProjectBackend(factory: LspProjectFactory, changed: () => void): ProjectBackend {
    const client = factory(), cleanup = new CleanupScope(); cleanup.defer(client.dispose);
    try {
        cleanup.defer(client.subscribe(changed));
        return Object.freeze({
            run: ({ input, scope }: ProjectRequest) => client.run(input, scope), isCurrent: client.isCurrent,
            cancel: cleanup.dispose, dispose: cleanup.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
        });
    } catch (error) { return cleanup.rollback(error); }
}
