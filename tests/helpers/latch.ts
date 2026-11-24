import type { Observable } from "../../src/index.ts";

export const latch = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};

export function waitForState<T>(state: Observable<T>, ready: (snapshot: T) => boolean): Promise<void> {
    return new Promise(resolve => {
        const check = () => {
            if (ready(state.getSnapshot())) {
                stop();
                resolve();
            }
        };
        const stop = state.subscribe(check);
        check();
    });
}
