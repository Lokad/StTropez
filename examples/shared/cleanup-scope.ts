/** Synchronous host ownership, compatible with the examples' ES2022 target. */
export class CleanupScope {
    private cleanups: (() => void)[] = [];
    private disposed = false;

    defer(cleanup: () => void): void {
        if (this.disposed) throw new Error("Cannot add an owner to a disposed scope.");
        this.cleanups.push(cleanup);
    }

    readonly dispose = (): void => {
        if (this.disposed) return;
        this.disposed = true;
        const errors: unknown[] = [];
        for (const cleanup of this.cleanups.splice(0).reverse()) {
            try {
                cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Host cleanup failed.");
    };

    rollback(error: unknown): never {
        try {
            this.dispose();
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Host attachment and cleanup failed.");
        }
        throw error;
    }
}
