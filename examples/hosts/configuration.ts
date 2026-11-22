import type { ResourceHandle, Workspace } from "../../src/index.ts";
import type { HostSaveQueue } from "../shared/save-queue.ts";
import type { Connection } from "./controller.ts";
import { FormSave } from "./form-save.ts";

export function configurationValidation(value: Connection): string | null {
    return typeof value.path !== "string" || !value.path.trim() ? "Path is required."
        : value.format !== "csv" ? "This fixture supports CSV configuration only." : null;
}

export class ConfigurationSave extends FormSave<Connection> {
    constructor(workspace: Workspace, saves: HostSaveQueue, resource: ResourceHandle<Connection>, track: (task: Promise<unknown>) => void) {
        super(workspace, saves, resource, track, { title: "Configuration", noun: "configuration", prefix: "configuration", validate: configurationValidation,
            canonical: value => Object.freeze({ ...value, path: value.path.trim() }),
            external: (value, path = "remote.csv") => Object.freeze({ ...value, path }) });
    }
}
