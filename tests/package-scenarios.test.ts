import test from "node:test";
import assert from "node:assert/strict";
import { consumerScenario } from "../scripts/package-scenarios.mjs";
const modes = ["lsp", "react", "pilot", "hunk", "activation", "workspace", "transitions"];

test("package workload selection retains the full route and each explicit single scenario", () => {
    assert.equal(consumerScenario([]), "full");
    assert.equal(consumerScenario(["--browser=firefox", "--skip-transitions"]), "full");
    for (const mode of modes) assert.equal(consumerScenario([`--${mode}-only`, "--browser=webkit"]), mode);
});

test("package workload selection refuses mixed modes instead of silently skipping a requested workload", () => {
    for (const [index, first] of modes.entries()) for (const second of modes.slice(index + 1)) {
        assert.throws(() => consumerScenario([`--${first}-only`, `--${second}-only`]), /Select one restored consumer scenario/);
        assert.throws(() => consumerScenario([`--${second}-only`, `--${first}-only`]), /Select one restored consumer scenario/);
    }
});
