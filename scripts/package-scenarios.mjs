import assert from "node:assert/strict";

export const packageScenarios = Object.freeze(Object.fromEntries(Object.entries({
    full: [],
    lsp: ["--lsp-only"],
    react: ["--react-only"],
    pilot: ["--pilot-only"],
    hunk: ["--hunk-only"],
    activation: ["--activation-only"],
    workspace: ["--workspace-only"],
    demo: [],
}).map(([name, flags]) => [name, Object.freeze(flags)])));

/**
 * Select a single restored-consumer workload before any package setup.
 * @param {readonly string[]} args
 */
export function consumerScenario(args) {
    const selected = Object.entries(packageScenarios)
        .filter(([, flags]) => flags.some(flag => args.includes(flag)))
        .map(([name]) => name);
    if (args.includes("--transitions-only")) selected.push("transitions");
    assert.ok(selected.length <= 1, "Select one restored consumer scenario; use --scenarios for multiple qualification scenarios.");
    return selected[0] ?? "full";
}
