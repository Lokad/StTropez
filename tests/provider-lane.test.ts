import test from "node:test";
import assert from "node:assert/strict";
import { ProviderLane } from "../examples/shared/provider-lane.ts";

test("a lazy provider lane ignores retired callbacks, including disposal callbacks after replacement", () => {
    const notifications: string[] = [], disposed: string[] = [], callbacks: (() => void)[] = [];
    const lane = new ProviderLane<{ name: string; dispose: () => void }>(value => notifications.push(value.name));
    const create = (name: string) => (changed: () => void) => {
        callbacks.push(changed); changed(); // Initial state is read from the acquired owner.
        return { name, dispose: () => { disposed.push(name); changed(); } };
    };
    assert.equal(lane.value, undefined);
    const first = lane.acquire(create("first"));
    assert.equal(lane.acquire(() => { throw new Error("Must reuse the live backend"); }), first);
    callbacks[0]!(); assert.deepEqual(notifications, ["first"]);
    lane.drop(); lane.drop();
    const second = lane.acquire(create("second"));
    callbacks[0]!(); callbacks[1]!();
    assert.equal(lane.value, second); assert.deepEqual(notifications, ["first", "second"]);
    lane.dispose(); lane.dispose(); callbacks[1]!();
    assert.deepEqual(disposed, ["first", "second"]); assert.deepEqual(notifications, ["first", "second"]);
    assert.equal(lane.value, undefined); assert.throws(() => lane.acquire(create("third")), /disposed/);
});

test("failed or interrupted provider acquisition can release ownership without poisoning a retry", () => {
    const lane = new ProviderLane<{ dispose: () => void }>(() => assert.fail("Retired owner published"));
    let failedChanged: (() => void) | undefined, released = 0;
    assert.throws(() => lane.acquire(changed => { failedChanged = changed; throw new Error("Factory failed"); }), /Factory failed/);
    const broken = lane.acquire(() => ({ dispose: () => { released++; throw new Error("Dispose failed"); } }));
    failedChanged!(); assert.equal(lane.value, broken);
    assert.throws(() => lane.drop(), /Dispose failed/); assert.equal(lane.value, undefined); lane.drop();
    assert.throws(() => lane.acquire(() => {
        lane.drop(); return { dispose: () => { released++; } };
    }), /cancelled/);
    lane.acquire(() => ({ dispose: () => { released++; } })); lane.dispose();
    assert.equal(released, 3);
});
