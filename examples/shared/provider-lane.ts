/** One lazy backend lifetime. Retired backends cannot publish into a replacement. */
export class ProviderLane<T extends Readonly<{ dispose: () => void }>> {
    private owner: { value: T | undefined } | undefined;
    private disposed = false;
    private readonly changed: (value: T) => void;

    constructor(changed: (value: T) => void) { this.changed = changed; }
    get value(): T | undefined { return this.owner?.value; }

    acquire(create: (changed: () => void) => T): T {
        if (this.disposed) throw new Error("Provider lane is disposed.");
        if (this.owner?.value) return this.owner.value;
        if (this.owner) throw new Error("Provider acquisition is already in progress.");
        const owner: { value: T | undefined } = { value: undefined }; this.owner = owner;
        try {
            const value = create(() => {
                if (this.owner === owner && owner.value) this.changed(owner.value);
            });
            if (this.owner !== owner || this.disposed) { value.dispose(); throw new Error("Provider acquisition was cancelled."); }
            owner.value = value; return value;
        } catch (error) { if (this.owner === owner) this.owner = undefined; throw error; }
    }

    drop(): void {
        const owner = this.owner; this.owner = undefined;
        owner?.value?.dispose();
    }
    dispose(): void { this.disposed = true; this.drop(); }
}
