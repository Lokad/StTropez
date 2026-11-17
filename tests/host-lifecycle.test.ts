import test from "node:test";
import assert from "node:assert/strict";
import { HostLifecycle } from "../examples/hosts/lifecycle.ts";

test("final host disposal starts every cleanup synchronously, awaits all settlements and is reentrant", async () => {
    const page = new EventTarget(), recovery = new EventTarget(), calls: string[] = [];
    const unmountError = new Error("unmount"), fixtureError = new Error("fixture"), deferredFixtureError = new Error("deferred fixture"), draftError = new Error("draft");
    let finishDraft!: (error: unknown) => void, finishFixture!: (error: unknown) => void, finishCommands!: () => void, nested: Promise<void> | undefined;
    const fixture = new Promise<void>((_resolve, reject) => { finishFixture = reject; });
    const draft = new Promise<void>((_resolve, reject) => { finishDraft = reject; });
    const commands = new Promise<void>(resolve => { finishCommands = resolve; });
    const lifecycle = new HostLifecycle(page, recovery, {
        controller: { startBackground: () => { calls.push("background"); }, recover: () => { calls.push("recover"); },
            dispose: () => { calls.push("commands"); return commands; } },
        bindings: { dispose: () => { calls.push("bindings"); } },
        draft: { dispose: () => { calls.push("draft"); return draft; } },
        mount: () => { calls.push("mount"); }, unmount: () => { calls.push("unmount"); nested = lifecycle.dispose(); throw unmountError; },
    });
    lifecycle.onDispose(() => { calls.push("fixture:first"); return fixture; });
    lifecycle.onDispose(() => { calls.push("fixture:last"); throw fixtureError; });
    lifecycle.start(); lifecycle.start();
    const completion = lifecycle.dispose(); assert.equal(nested, completion); assert.equal(lifecycle.dispose(), completion);
    const failures = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
    const rejected = assert.rejects(completion, error => { assert.deepEqual(failures(error), [unmountError, fixtureError, deferredFixtureError, draftError]); return true; });
    assert.deepEqual(calls, ["background", "mount", "unmount", "bindings", "fixture:last", "fixture:first", "draft", "commands"]);
    recovery.dispatchEvent(new Event("click")); page.dispatchEvent(new Event("pagehide"));
    assert.throws(() => lifecycle.mount(), /not active/); assert.throws(() => lifecycle.onDispose(() => {}), /disposed/);
    let settled = false; void completion.then(() => { settled = true; }, () => { settled = true; });
    finishDraft(draftError); await Promise.resolve(); assert.equal(settled, false);
    finishCommands(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
    finishFixture(deferredFixtureError); await rejected; assert.equal(settled, true); assert.equal(calls.length, 8);
});

test("failed host startup retires event handlers and settles resources without a fixture harness", async () => {
    const page = new EventTarget(), recovery = new EventTarget(), calls: string[] = [], error = new Error("mount refused"), reported: unknown[] = [];
    const lifecycle = new HostLifecycle(page, recovery, {
        controller: { startBackground: () => { calls.push("background"); }, recover: () => { calls.push("recover"); }, dispose: async () => { calls.push("commands"); } },
        bindings: { dispose: () => { calls.push("bindings"); } }, draft: { dispose: async () => { calls.push("draft"); } },
        mount: () => { calls.push("mount"); throw error; }, unmount: () => { calls.push("unmount"); }, reportError: value => { reported.push(value); },
    });
    assert.throws(() => lifecycle.start(), value => value === error); assert.equal(lifecycle.disposed, true);
    await lifecycle.dispose(); recovery.dispatchEvent(new Event("click")); page.dispatchEvent(new Event("pagehide"));
    assert.deepEqual(calls, ["background", "mount", "unmount", "bindings", "draft", "commands"]);
    assert.deepEqual(reported, []); assert.throws(() => lifecycle.start(), /disposed/);
});
