/** Result of a command or request against a captured workspace or view. */
export type Outcome<T> = Readonly<
    { status: "done"; value: T }
    | { status: "stale" }
    | { status: "refused"; reason: string }
    | { status: "failed"; error: unknown }
>;

export const stale = Object.freeze({ status: "stale" } as const);
export const done = <T>(value: T) => Object.freeze({ status: "done" as const, value });
export const refused = <R extends string>(reason: R) => Object.freeze({ status: "refused" as const, reason });
export const failed = (error: unknown) => Object.freeze({ status: "failed" as const, error });
