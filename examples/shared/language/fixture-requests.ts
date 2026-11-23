export type FixturePolicy<F> = Readonly<{ delay: number; fault?: F }>;

/** Delay persists across requests. A fault belongs to the next request from this owner. */
export function fixtureRequests<F>(feature: string) {
    let delay = 0, fault: F | undefined;
    return {
        setDelay(value: number) {
            if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError(`Invalid ${feature} delay.`);
            delay = value;
        },
        faultNext(value: F) { fault = value; },
        take(): FixturePolicy<F> {
            const policy = fault === undefined ? { delay } : { delay, fault };
            fault = undefined;
            return policy;
        },
    };
}
