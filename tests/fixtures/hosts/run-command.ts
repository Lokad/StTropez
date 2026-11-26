import type { DocumentId, TextResourceHandle, Workspace } from "../../../src/index.ts";
import type { ConfigurationSave } from "./configuration.ts";
import type { Connection } from "./controller.ts";
import type { FormId } from "./form-save.ts";

export type RunSettings = Readonly<{ mode: "preview" | "inspect" }>;
type Captured<T, Id> = Readonly<{ id: Id; revision: number; value: T; serverVersion: string | null }>;
export type RunSubmission = Readonly<{
    source: Captured<string, DocumentId>; configuration: Captured<Connection, FormId>; settings: RunSettings;
}>;

export async function runWithResources<R>(
    workspace: Workspace, source: TextResourceHandle, form: ConfigurationSave, settings: RunSettings,
    submit: (input: RunSubmission) => Promise<R>,
): Promise<R> {
    const document = workspace.document(source.id);
    const { value, revision, serverVersion } = form.values.getSnapshot();
    const lease = workspace.acquire(source.id);
    try {
        return await submit(Object.freeze({
            source: Object.freeze({ id: source.id, revision: document.revision, value: document.text(),
                serverVersion: source.metadata.getSnapshot().serverVersion }),
            configuration: Object.freeze({ id: form.id, value, revision, serverVersion }),
            settings: Object.freeze({ mode: settings.mode }),
        }));
    } finally {
        lease.release();
    }
}
