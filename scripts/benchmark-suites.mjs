import assert from "node:assert/strict";

/** @typedef {{id: string, args: readonly string[], environment: readonly string[], reports: readonly string[]}} BenchmarkSuite */
const sourceIds = ["model", "editing", "viewport", "comparison"];
/** @type {BenchmarkSuite[]} */
const entries = sourceIds.map((id) => ({
    id,
    args: [`scripts/benchmark-${id}.mjs`],
    environment: [],
    reports: [id === "model" ? "artifacts/bench/model.json" : `artifacts/bench/${id}`]
}));
/** @type {Readonly<Record<string, Readonly<BenchmarkSuite>>>} */
export const benchmarkSuites = Object.freeze(
    Object.fromEntries(
        entries.map((entry) => [
            entry.id,
            Object.freeze({
                ...entry,
                args: Object.freeze(entry.args),
                environment: Object.freeze(entry.environment),
                reports: Object.freeze(entry.reports)
            })
        ])
    )
);
/** @type {Readonly<Record<string, readonly string[]>>} */
export const benchmarkGroups = Object.freeze({
    default: Object.freeze(["model", "editing"]),
    all: Object.freeze(sourceIds)
});

/** @param {readonly string[]} args */
export function selectBenchmarks(args) {
    const separator = args.indexOf("--"),
        options = separator < 0 ? args : args.slice(0, separator);
    const forwarded = separator < 0 ? [] : args.slice(separator + 1);
    assert.equal(new Set(options).size, options.length, "Benchmark options must not repeat.");
    assert.ok(
        options.every(
            (option) => option === "--list" || option.startsWith("--suite=") || option.startsWith("--group=")
        ),
        "Select --group=<name> or --suite=<name>; put suite arguments after --."
    );
    const selectors = options.filter((option) => option !== "--list");
    assert.ok(selectors.length <= 1, "Select one benchmark group or suite.");
    const selector = selectors[0] ?? "--group=default",
        group = selector.startsWith("--group="),
        name = selector.slice(selector.indexOf("=") + 1);
    const ids = group
        ? Object.hasOwn(benchmarkGroups, name)
            ? benchmarkGroups[name]
            : undefined
        : Object.hasOwn(benchmarkSuites, name)
          ? [name]
          : undefined;
    assert.ok(ids, `Unknown benchmark ${group ? "group" : "suite"}: ${name}`);
    assert.ok(!group || !forwarded.length, "Group arguments are ambiguous; use a named suite to pass workload flags.");
    const suites = ids.map((id) => {
        const suite = benchmarkSuites[id];
        assert.ok(suite, `Missing benchmark suite: ${id}`);
        return Object.freeze({ ...suite, args: Object.freeze([...suite.args, ...forwarded]) });
    });
    return Object.freeze({
        key: `${group ? "group" : "suite"}-${name}`,
        list: options.includes("--list"),
        suites: Object.freeze(suites),
        omitted: Object.freeze(Object.keys(benchmarkSuites).filter((id) => !ids.includes(id)))
    });
}
