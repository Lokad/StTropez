import type { FindSnapshot } from "./find.ts";

export function resultPosition(current: number, total: number): string {
    return String(current) + " of " + total;
}

function matchCount(count: number): string {
    return `${count} ${count === 1 ? "match" : "matches"}`;
}

export function findNotice(state: FindSnapshot): string {
    return state.reason === "replaced" ? `Replaced ${matchCount(state.replacedCount)}.` : state.message;
}

export function findStatus(state: FindSnapshot): string {
    if (!state.query) return "";
    const interrupted = state.reason === "cancelled" && (state.status === "ready" || state.status === "searching");
    if (state.message && state.reason !== "replaced" && !interrupted) return state.message;
    if (state.status === "replacing") return "Replacing…";
    const count = state.current !== null ? resultPosition(state.current + 1, state.count)
        : state.count ? matchCount(state.count) : "";
    if (state.status === "searching") return count ? `Searching… ${count}` : "Searching…";
    const result = count || "No matches";
    if (state.reason === "replaced") return `${findNotice(state)} ${result}`;
    return state.wrappedTo ? `${result} · Wrapped to ${state.wrappedTo}` : result;
}
