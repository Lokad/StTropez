import type { DiffRange } from "../core/diff.ts";
import type { TextComparisonSnapshot } from "./comparison.ts";
import type { CompletionSnapshot } from "./completion-controller.ts";
import { findStatus, resultPosition } from "./find-status.ts";

const defaults = Object.freeze({
    text: (label: string) => label,
    findStatus,
    reviewChanges: (count: number) => `Review ${count} ${count === 1 ? "change" : "changes"}.`,
    readOnlyFile: (file: string) => file + " is read-only.",
    resultPosition,
    resultPage: (first: number, last: number, total: number) => `${first}–${last} of ${total}`,
    location: (file: string, line: number, column: number) => `${file} · ${line}:${column}`,
    truncated: (prefix: string, units: number) => `${prefix}… (${units} UTF-16 units)`,
    completionStatus(state: CompletionSnapshot, filterManual: boolean) {
        return resultPosition(state.choiceIndex + 1, state.choices.length)
            + (state.completionIncomplete ? " · partial list" : "")
            + (state.omittedCompletions.length ? " · " + state.omittedCompletions.length + " unsupported" : "")
            + (filterManual ? " · type to filter" : "");
    },
    omittedCompletions: (state: CompletionSnapshot) =>
        state.omittedCompletions.map(item => item.label + ": " + item.reason).join("\n"),
});

export type ControlStrings = Readonly<Partial<typeof defaults> & {
    commandLabel?: (id: string, fallback: string) => string | undefined;
    heading?: (side: "baseline" | "working", state: TextComparisonSnapshot) => string | undefined;
    excerpt?: (side: "baseline" | "working", range: DiffRange, visibleText: string) => string | undefined;
    statusText?: (state: TextComparisonSnapshot) => string | undefined;
    restoreHint?: (state: TextComparisonSnapshot) => string | undefined;
}>;

export function resolveControlStrings(strings?: ControlStrings): typeof defaults & ControlStrings {
    return strings ? Object.freeze({ ...defaults, ...strings }) : defaults;
}
