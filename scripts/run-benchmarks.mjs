import { benchmarkGroups, benchmarkSuites, selectBenchmarks } from "./benchmark-suites.mjs";
import { runBenchmarkPlan } from "./benchmark-runner.mjs";

const plan = selectBenchmarks(process.argv.slice(2));
if (plan.list)
    console.log(
        JSON.stringify({ ...plan, groups: benchmarkGroups, catalogue: Object.values(benchmarkSuites) }, null, 2)
    );
else {
    const result = await runBenchmarkPlan(plan);
    console.log(`Benchmark campaign ${result.status}: ${result.file}`);
    process.exitCode = result.exitCode;
}
