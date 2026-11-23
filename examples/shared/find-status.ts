import type { FindSnapshot } from "../../src/browser/index.ts";

export function findStatus(state: FindSnapshot): string {
    if (!state.query) return "";
    if (state.message && state.reason !== "replaced") return state.message;
    const count = state.current !== null ? `${state.current + 1} of ${state.count}`
        : state.count ? `${state.count} ${state.count === 1 ? "match" : "matches"}` : "";
    if (state.status === "searching") return count ? `Searching… ${count}` : "Searching…";
    const result = count || "No matches";
    if (state.reason === "replaced") return `${state.message} ${result}`;
    return state.wrappedTo ? `${result} · Wrapped to ${state.wrappedTo}` : result;
}
