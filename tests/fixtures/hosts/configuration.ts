import type { Connection } from "./controller.ts";
import { FormSave } from "./form-save.ts";

export function configurationValidation(value: Connection): string | null {
    return typeof value.path !== "string" || !value.path.trim() ? "Path is required."
        : value.format !== "csv" ? "This fixture supports CSV configuration only." : null;
}

export class ConfigurationSave extends FormSave<Connection> {
    constructor(onError: (error: Error) => void) {
        super({ path: "source.csv", format: "csv" }, { title: "Configuration", noun: "configuration", prefix: "configuration", validate: configurationValidation,
            canonical: value => Object.freeze({ ...value, path: value.path.trim() }),
            external: (value, path = "remote.csv") => Object.freeze({ ...value, path }) }, onError);
    }
}
