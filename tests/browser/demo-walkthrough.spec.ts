import { test } from "./fixtures.ts";
import { runDemoWalkthrough, runDemoConflict } from "./demo-walkthrough.ts";

test("complete real-provider edit, inspect, navigate, rename, fix, review, save and recover walkthrough", async ({ page }, info) => {
    test.setTimeout(120000);
    const receipt = await runDemoWalkthrough(page);
    await info.attach("demo-walkthrough", { contentType: "application/json", body: JSON.stringify(receipt) });
});

test("real provider pages preserve local project edits through conflict review and a guarded save", async ({ page }, info) => {
    test.setTimeout(120000);
    const receipt = await runDemoConflict(page);
    await info.attach("demo-conflict-walkthrough", { contentType: "application/json", body: JSON.stringify(receipt) });
});
