import type { SnapshotValue, Workspace } from "../../src/index.ts";
import type { HostSaveQueue } from "../shared/save-queue.ts";
import { FormSave } from "./form-save.ts";

export type TransferSettings = Readonly<{ destination: string; batchSize: string; [key: string]: SnapshotValue }>;
export function transferValidation(value: TransferSettings): string | null {
    if (typeof value.destination !== "string" || !value.destination.trim()) return "Transfer destination is required.";
    return typeof value.batchSize !== "string" || !/^[1-9]\d{0,5}$/.test(value.batchSize) || Number(value.batchSize) > 100000
        ? "Batch size must be an integer from 1 to 100000." : null;
}
export class HostTransfer {
    readonly resource;
    readonly save;
    private readonly workspace: Workspace;
    constructor(workspace: Workspace, saves: HostSaveQueue, track: (task: Promise<unknown>) => void) {
        this.workspace = workspace;
        this.resource = workspace.createResource<TransferSettings>({ scope: "host-fixture", resource: "transfer", variant: "working" }, "Transfer settings", { value: { destination: "target.csv", batchSize: "1000" } });
        this.save = new FormSave(workspace, saves, this.resource, track, { title: "Transfer settings", noun: "transfer settings", prefix: "transfer", validate: transferValidation,
            canonical: value => Object.freeze({ ...value, destination: value.destination.trim() }),
            external: (value, destination = "remote-target.csv") => Object.freeze({ ...value, destination }) });
    }
    readonly update = (field: "destination" | "batchSize", value: string): void => {
        if (this.save.debug().disposed) return; const s = this.resource.getSnapshot(); if (s.state !== "ready") return;
        this.workspace.updateResource(this.resource, { expectedRevision: s.revision, origin: "human", value: { ...s.value(), [field]: value } });
    };
}
