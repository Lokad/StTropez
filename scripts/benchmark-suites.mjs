import assert from "node:assert/strict";

/** @typedef {{id: string, args: readonly string[], environment: readonly string[], reports: readonly string[], setup?: string, note?: string}} BenchmarkSuite */
const sourceIds = ["model", "workspace", "editing", "paragraph", "bidi", "host-input", "host-folding", "host-reference",
    "host-pointer", "host-drag-scroll", "host-word-selection", "navigation", "hosts", "save-conflicts", "save-recovery",
    "comparison", "trace", "storage", "viewport", "services", "bulk", "graphemes", "host-reference-focus", "host-table-paste"];
/** @type {Record<string, readonly string[]>} */
const environment = {
    "host-input": ["STTROPEZ_INPUT_SMOKE"], "host-reference": ["STTROPEZ_REFERENCE_SMOKE"],
    "host-pointer": ["STTROPEZ_POINTER_SMOKE"], "host-drag-scroll": ["STTROPEZ_DRAG_SMOKE"],
    "host-word-selection": ["STTROPEZ_WORD_SELECTION_SMOKE", "STTROPEZ_WORD_SELECTION_INSPECT"],
    hosts: ["STTROPEZ_HOST_SMOKE"], "save-conflicts": ["STTROPEZ_CONFLICT_SMOKE"],
    "save-recovery": ["STTROPEZ_SAVE_RECOVERY_SMOKE"], storage: ["STTROPEZ_STORAGE_ROUNDS"],
    bulk: ["STTROPEZ_BULK_ROUNDS"], "host-reference-focus": ["STTROPEZ_REFERENCE_FOCUS_SMOKE", "STTROPEZ_REFERENCE_FOCUS_INSPECT"],
};
/** @type {Record<string, readonly string[]>} */
const reports = { model: ["artifacts/bench/model.json"], workspace: ["artifacts/bench/model.json", "artifacts/bench/latest.json"], trace: ["artifacts/bench/phases.json"] };
/** @type {BenchmarkSuite[]} */
const entries = sourceIds.map(id => ({ id,
    args: [...(id === "paragraph" ? ["--expose-gc"] : []), id === "workspace" ? "scripts/benchmark.mjs" : `scripts/benchmark-${id}.mjs`],
    environment: environment[id] ?? [], reports: reports[id] ?? [`artifacts/bench/${id}`],
    ...(id === "workspace" ? { note: "Runs both the headless model and native workspace baseline; the standalone model command is separate." } : {}),
}));
for (const kind of ["pilot", "hunk", "react"]) entries.push({ id: `package-${kind}`, setup: "pack:nuget",
    args: ["scripts/test-package.mjs", `--${kind}-only`, "--bench"], environment: [], reports: ["artifacts/package"],
    note: "Packs/restores assets before measuring the consuming host." });
/** @type {Readonly<Record<string, Readonly<BenchmarkSuite>>>} */
export const benchmarkSuites = Object.freeze(Object.fromEntries(entries.map(entry => [entry.id, Object.freeze({ ...entry,
    args: Object.freeze(entry.args), environment: Object.freeze(entry.environment), reports: Object.freeze(entry.reports),
})])));
/** @type {Readonly<Record<string, readonly string[]>>} */
export const benchmarkGroups = Object.freeze({
    default: Object.freeze(["model", "editing"]),
    pilot: Object.freeze(["host-input", "comparison", "save-conflicts"]),
    all: Object.freeze(["workspace", "viewport", "editing", "services", "bulk", "comparison", "hosts", "save-conflicts",
        "save-recovery", "navigation", "host-folding", "host-table-paste", "host-pointer", "host-input", "host-reference", "bidi", "paragraph", "graphemes"]),
});

/** @param {readonly string[]} args */
export function selectBenchmarks(args) {
    const separator = args.indexOf("--"), options = separator < 0 ? args : args.slice(0, separator);
    const forwarded = separator < 0 ? [] : args.slice(separator + 1);
    assert.equal(new Set(options).size, options.length, "Benchmark options must not repeat.");
    assert.ok(options.every(option => option === "--list" || option.startsWith("--suite=") || option.startsWith("--group=")),
        "Select --group=<name> or --suite=<name>; put suite arguments after --.");
    const selectors = options.filter(option => option !== "--list");
    assert.ok(selectors.length <= 1, "Select one benchmark group or suite.");
    const selector = selectors[0] ?? "--group=default", group = selector.startsWith("--group="), name = selector.slice(selector.indexOf("=") + 1);
    const ids = group ? Object.hasOwn(benchmarkGroups, name) ? benchmarkGroups[name] : undefined
        : Object.hasOwn(benchmarkSuites, name) ? [name] : undefined;
    assert.ok(ids, `Unknown benchmark ${group ? "group" : "suite"}: ${name}`);
    assert.ok(!group || !forwarded.length, "Group arguments are ambiguous; use a named suite to pass workload flags.");
    const suites = ids.map(id => {
        const suite = benchmarkSuites[id];
        assert.ok(suite, `Missing benchmark suite: ${id}`);
        return Object.freeze({ ...suite, args: Object.freeze([...suite.args, ...forwarded]) });
    });
    return Object.freeze({ key: `${group ? "group" : "suite"}-${name}`, list: options.includes("--list"),
        suites: Object.freeze(suites), omitted: Object.freeze(Object.keys(benchmarkSuites).filter(id => !ids.includes(id))),
    });
}
