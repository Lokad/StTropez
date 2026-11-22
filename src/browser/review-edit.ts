type ReviewRefusal = "expired" | "not-writable" | "no-changes";

export type ReviewEditResult = Readonly<
    { applied: true }
    | { applied: false; reason: ReviewRefusal }
    | { applied: false; reason: "failed"; message: string }
>;

export const reviewApplied = Object.freeze({ applied: true } as const);
export function reviewRefused(reason: ReviewRefusal): ReviewEditResult {
    return Object.freeze({ applied: false, reason });
}
export function reviewFailed(message: string): ReviewEditResult {
    return Object.freeze({ applied: false, reason: "failed", message });
}
