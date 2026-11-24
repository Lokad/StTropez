/** Result of an asynchronous request against a captured workspace or view. */
export type Outcome<T> = Readonly<
    { status: "done"; value: T }
    | { status: "stale" }
    | { status: "refused"; reason: string }
    | { status: "failed"; error: unknown }
>;

export const stale = Object.freeze({ status: "stale" } as const);
