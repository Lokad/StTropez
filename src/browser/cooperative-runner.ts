type Turn = (work: () => void) => void;
type Host = Readonly<{ performance: Pick<Performance, "now">;
    setTimeout: (work: () => void, delay: number) => number; clearTimeout: (timer: number) => void }>;
export type CooperativeRunner = Readonly<{
    slice<T>(advance: () => T, pending: (result: T) => boolean, calls: number): T;
    schedule: (work: () => void, delay?: number, enter?: Turn) => () => void;
    cancel: () => void;
}>;
const direct: Turn = work => work();

export const commandBudget = Object.freeze({ sliceMs: 4, cursorUnits: 4096, wordCalls: 32, graphemeCalls: 8,
    foldCalls: 64, languageUnits: 256, initialLanguageCalls: 64, maxCalls: 512, columnCalls: 64,
    inlineRanges: 32,
    queuedCalls: 8, queuedActions: 256, queuedUnits: 65536 });

/** Shared task mechanics. Owners retain captures, iterator disposal, failure handling and completion. */
export function createCooperativeRunner(host: Host): CooperativeRunner {
    const scheduled = new Set<() => void>();
    return Object.freeze({
        /** Advance at least once; pending may also check the owner's authority after each advance. */
        slice<T>(advance: () => T, pending: (result: T) => boolean, calls: number): T {
            const began = host.performance.now(); let result: T, count = 0;
            do { result = advance(); }
            while (pending(result) && ++count < calls && host.performance.now() - began < commandBudget.sliceMs);
            return result;
        },
        /** Each continuation is a timer task; enter preserves the owner's synchronous turn accounting. */
        schedule(work: () => void, delay = 0, enter: Turn = direct): () => void {
            let pending = true;
            const cancel = () => { if (!pending) return; pending = false; host.clearTimeout(timer); scheduled.delete(cancel); };
            const timer = host.setTimeout(() => {
                if (!pending) return;
                enter(() => { if (!pending) return; pending = false; scheduled.delete(cancel); work(); });
            }, delay);
            scheduled.add(cancel); return cancel;
        },
        cancel(): void { for (const cancel of scheduled) cancel(); },
    });
}
