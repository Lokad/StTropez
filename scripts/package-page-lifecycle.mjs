import assert from "node:assert/strict";

/**
 * Synthetic transitions check the consumer's policy, not real BFCache eligibility.
 * @param {import("@playwright/test").Page} page
 * @param {ReturnType<Window["activationFixture"]["snapshot"]>["phase"]} phase
 */
export async function retainPackagedPage(page, phase) {
    const result = await page.evaluate(() => {
        const before = window.activationFixture.snapshot(), inputs = [...document.querySelectorAll("#editor textarea")];
        for (let index = 0; index < 2; index++) {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        }
        const current = [...document.querySelectorAll("#editor textarea")];
        return { before, after: window.activationFixture.snapshot(), sameInputs: inputs.length === current.length && inputs.every((input, index) => input === current[index]) };
    });
    assert.equal(result.before.phase, phase);
    assert.deepEqual(result.after, result.before, `Persisted page transitions changed the ${phase} session`);
    assert.equal(result.sameInputs, true, "Persisted page transitions replaced the mounted inputs");
}

/** @param {import("@playwright/test").Page} page */
export async function closePackagedPage(page) {
    const result = await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
        const first = window.activationFixture.snapshot();
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
        return { first, repeated: window.activationFixture.snapshot(), inputs: document.querySelectorAll("#editor textarea").length,
            stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length };
    });
    assert.equal(result.first.phase, "disposed");
    assert.ok(result.first.session, "Disposal must retain the activated session snapshot");
    assert.equal(result.first.session.disposed, true);
    assert.deepEqual(result.repeated, result.first); assert.equal(result.inputs, 0); assert.equal(result.stylesheets, 0);
    const diagnostics = result.first.session.diagnostics;
    for (const key of /** @type {const} */ (["resources", "documents", "tabs", "views", "leases", "subscriptions"])) assert.equal(diagnostics[key], 0, key);
    return diagnostics;
}
