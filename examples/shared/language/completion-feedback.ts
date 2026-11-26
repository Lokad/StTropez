import type { CompletionSnapshot } from "../../../src/browser/index.ts";

const messages = {
    idle: "Language provider connected.",
    connecting: "Connecting to the language provider…",
    disconnected: "Language provider disconnected. Local editing is available.",
    pending: "Getting completions…",
    ready: "Suggestions ready.",
    empty: "No suggestions here. Try a different prefix.",
    busy: "Finish the current edit before requesting suggestions.",
    "unsupported-selection": "Use one single-line selection, or carets with matching text.",
    malformed: "Malformed completion response.",
    failed: "Language provider unavailable. Request suggestions again.",
    expired: "Suggestions expired.",
    applied: "Completion applied.",
    rejected: "The edit was refused.",
    resolving: "Loading completion details…",
    accepting: "Waiting for completion details before inserting.",
    snippet: "Editing a snippet field.",
    disposed: ""
} satisfies Record<CompletionSnapshot["status"], string>;

export function completionFeedback(state: CompletionSnapshot): string {
    if (state.status === "idle" && !state.connected) return "Completion dismissed.";
    if (state.reason) return messages[state.status] + " " + state.reason;
    if (state.status === "empty" && state.omittedCompletions.length)
        return state.omittedCompletions.length + " unsupported completion choices omitted.";
    return messages[state.status];
}
