import type { LoadedResource, Workspace } from "../../../src/index.ts";

export function createWorkingSource(workspace: Workspace, name: string, title: string, loaded?: LoadedResource<string>, scope = "host-fixture") {
    const uri = `host+fixture:${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
    return workspace.createTextResource({ scope, resource: name, variant: "working" }, title, loaded, undefined,
        { language: { uri, languageId: "fixture" } });
}
