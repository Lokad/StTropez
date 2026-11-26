import type { SnapshotValue } from "./values.ts";
import { FormSave } from "./form-save.ts";

export type TransferSettings = Readonly<{ destination: string; batchSize: string; [key: string]: SnapshotValue }>;
export function transferValidation(value: TransferSettings): string | null {
    if (typeof value.destination !== "string" || !value.destination.trim()) return "Transfer destination is required.";
    return typeof value.batchSize !== "string" || !/^[1-9]\d{0,5}$/.test(value.batchSize) || Number(value.batchSize) > 100000
        ? "Batch size must be an integer from 1 to 100000." : null;
}
export class HostTransfer {
    readonly save: FormSave<TransferSettings>;
    constructor(onError: (error: Error) => void) {
        this.save = new FormSave<TransferSettings>({ destination: "target.csv", batchSize: "1000" }, { title: "Transfer settings", noun: "transfer settings", prefix: "transfer", validate: transferValidation,
            canonical: value => Object.freeze({ ...value, destination: value.destination.trim() }),
            external: (value, destination = "remote-target.csv") => Object.freeze({ ...value, destination }) }, onError);
    }
    readonly update = (field: "destination" | "batchSize", value: string): void => {
        this.save.updateValue({ ...this.save.values.getSnapshot().value, [field]: value });
    };
}
