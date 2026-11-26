import { HostCell } from "../../../examples/shared/observable.ts";
import { equalValue, snapshotValue, type Immutable, type SnapshotValue } from "../../../src/core/values.ts";
import type { Observable } from "../../../src/index.ts";

export type FormId = "configuration" | "transfer";
export type FormSnapshot<T> = Readonly<{
    value: Immutable<T>;
    revision: number;
    dirty: boolean;
    serverVersion: string | null;
    saveStatus: "idle" | "saving" | "failed" | "conflict";
}>;
type Capture<T> = Readonly<{ resourceId: FormId; revision: number; value: Immutable<T>; expectedServerVersion: string | null }>;
type Reviewed = Readonly<{ version: string }>;
type State<T> = Readonly<{ conflict: Readonly<{ version: string; value: Immutable<T> | null }> | null }>;
export type FormSavePresentation<T> = Readonly<{
    title: string; noun: string; resource: FormSnapshot<T>; status: string; validation: string | null;
    preview: string | null; canSave: boolean; canReview: boolean; canSaveReviewed: boolean;
    capture: Capture<T> | null; review: Reviewed | null; disposed: boolean;
}>;
export type FormPolicy<T> = Readonly<{
    title: string; noun: string; prefix: FormId; validate: (value: Immutable<T>) => string | null;
    canonical: (value: Immutable<T>) => Immutable<T>; external: (value: Immutable<T>, text?: string) => Immutable<T>;
}>;

/** These forms belong to the fixture. Their pending callbacks capture one immutable submission. */
export class FormSave<T extends SnapshotValue> {
    readonly id: FormId;
    readonly title: string;
    readonly values: Observable<FormSnapshot<T>>;
    readonly presentation: Observable<FormSavePresentation<T>>;
    private readonly data: HostCell<FormSnapshot<T>>;
    private readonly notices: HostCell<FormSavePresentation<T>>;
    private readonly policy: FormPolicy<T>;
    private readonly onError: (error: Error) => void;
    private baseline: Immutable<T>;
    private remote: Immutable<T>;
    private remoteVersion: string | null = null;
    private serial = 0;
    private request: Capture<T> | null = null;
    private reviewed: Reviewed | null = null;
    private conflict: State<T>["conflict"] = null;
    private message = "";
    private disposed = false;

    constructor(initial: T, policy: FormPolicy<T>, onError: (error: Error) => void) {
        this.id = policy.prefix;
        this.title = policy.title;
        this.policy = policy;
        this.onError = onError;
        this.baseline = this.remote = snapshotValue(initial);
        this.data = new HostCell<FormSnapshot<T>>({
            value: this.baseline, revision: 0, dirty: false, serverVersion: null, saveStatus: "idle",
        });
        this.values = this.data.observable;
        this.notices = new HostCell(this.describe());
        this.presentation = this.notices.observable;
    }
    private describe(): FormSavePresentation<T> {
        const resource = this.data.get();
        const validation = this.policy.validate(resource.value);
        const available = !this.disposed && !this.request && validation === null;
        const text = this.conflict?.value && JSON.stringify(this.conflict.value, null, 2);
        return {
            title: this.title, noun: this.policy.noun, resource, validation, disposed: this.disposed,
            status: `${this.title} ${resource.dirty ? "Unsaved" : "Saved"} · Save status: ${resource.saveStatus} · ${validation ?? this.message}`,
            preview: text ? text.slice(0, 4096) + (text.length > 4096 ? "\n… Preview limited to 4,096 characters; full server value retained." : "") : null,
            canSave: available && !this.conflict && (resource.dirty || resource.saveStatus === "failed"),
            canReview: !this.disposed && !this.request && !!this.conflict,
            canSaveReviewed: available && !!this.reviewed,
            capture: this.request, review: this.reviewed,
        };
    }
    private publish(message: string, patch?: Partial<FormSnapshot<T>>) {
        this.message = message;
        if (patch) this.data.set({ ...this.data.get(), ...patch });
        this.notices.set(this.describe());
    }
    updateValue(value: T) {
        if (this.disposed) return;
        const current = this.data.get();
        const next = snapshotValue(value);
        if (!equalValue(current.value, next)) this.publish(this.message, {
            value: next, revision: current.revision + 1, dirty: !equalValue(next, this.baseline),
        });
    }
    validation() { return this.presentation.getSnapshot().validation; }
    canSave() { return this.presentation.getSnapshot().canSave; }
    canSaveReviewed() { return this.presentation.getSnapshot().canSaveReviewed; }
    private submit(version: string | null) {
        const { revision, value } = this.data.get();
        this.request = Object.freeze({ resourceId: this.id, revision, value, expectedServerVersion: version });
        this.publish(`Saving captured ${this.policy.noun}…`, { saveStatus: "saving" });
    }
    readonly save = () => {
        if (this.canSave()) this.submit(this.data.get().serverVersion);
    };
    readonly finish = (expected = this.request) => {
        if (!expected || expected !== this.request) return;
        this.request = this.reviewed = null;
        if (expected.expectedServerVersion !== this.remoteVersion) {
            this.conflict = { version: this.remoteVersion!, value: null };
            this.publish(`${this.title} save conflicted. Review the remote ${this.policy.noun}.`, { saveStatus: "conflict" });
            return;
        }
        this.baseline = this.remote = this.policy.canonical(expected.value);
        this.remoteVersion = `${this.id}-v${++this.serial}`;
        this.conflict = null;
        const current = this.data.get();
        const value = current.revision === expected.revision ? this.baseline : current.value;
        this.publish(`Captured ${this.policy.noun} saved. Later edits are retained.`, {
            value, revision: current.revision + Number(!equalValue(value, current.value)),
            saveStatus: "idle", serverVersion: this.remoteVersion, dirty: !equalValue(value, this.baseline),
        });
    };
    readonly fail = (expected = this.request) => {
        if (!expected || expected !== this.request) return;
        this.request = null;
        this.publish(`${this.title} save failed. Current values are retained; retry when ready.`, { saveStatus: "failed" });
        this.onError(new Error(this.message));
    };
    readonly externalWrite = (text?: string) => {
        if (this.disposed) return;
        this.remote = this.policy.external(this.remote, text);
        this.remoteVersion = `${this.id}-v${++this.serial}`;
        this.publish(`Synthetic remote ${this.policy.noun} changed. Local values are retained.`);
    };
    readonly review = () => {
        if (!this.describe().canReview || this.remoteVersion === null) return;
        this.reviewed = Object.freeze({ version: this.remoteVersion });
        this.conflict = { version: this.remoteVersion, value: this.remote };
        this.publish(`Remote ${this.policy.noun} captured. Correct local fields, then save the reviewed ${this.policy.noun}.`);
    };
    readonly saveReviewed = (expected = this.reviewed) => {
        if (expected && expected === this.reviewed && this.canSaveReviewed()) this.submit(expected.version);
    };
    capture() { return this.request; }
    debug() {
        return { pending: !!this.request, request: this.request, conflictVersion: this.conflict?.version ?? null,
            reviewedVersion: this.reviewed?.version ?? null, reviewReady: this.canSaveReviewed(),
            subscriptions: this.notices.count() + this.data.count(), disposed: this.disposed };
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.request = null;
        this.publish(this.message);
    }
}
