export type KernelStatus = "running" | "ready" | "failed" | "disposed";
export type KernelCursor<P> = Readonly<{ next: (workBudget?: number) => P; snapshot: () => P; dispose: () => void }>;

/** Work is counted between cooperative checkpoints, which may overshoot the requested budget. */
export function validateWorkBudget(budget: number, label: string): void {
    if (!Number.isSafeInteger(budget) || budget < 256) throw new RangeError(`${label} budget must be an integer of at least 256 units.`);
}

/** Shared synchronous driver; the host schedules calls and the kernel supplies its own checkpoints. */
export function kernelCursor<R, P>(iterator: Generator<void, R | null> | null, work: () => number,
    progress: (status: KernelStatus, result: R | null, failure: string | null) => P, label: string): KernelCursor<P> {
    let active: Generator<void, R | null> | null = iterator, result: R | null = null, status: KernelStatus = "running", failure: string | null = null, busy = false; iterator = null;
    const snapshot = () => progress(status, result, failure);
    return Object.freeze({ snapshot,
        next: (workBudget = 4096) => {
            if (busy) throw new Error(`${label} cursor is busy.`);
            validateWorkBudget(workBudget, label);
            busy = true;
            try {
                const start = work();
                while (active && work() - start < workBudget) { const step = active.next(); if (step.done) { result = step.value; status = result ? "ready" : "disposed"; active = null; } }
                return snapshot();
            } catch (error) { active?.return(null); active = null; result = null; status = "failed"; failure = error instanceof Error ? error.message : `${label} failed.`; throw error; }
            finally { busy = false; }
        },
        dispose: () => { if (busy) throw new Error(`${label} cursor is busy.`); active?.return(null); active = null; result = null; status = "disposed"; }
    });
}
