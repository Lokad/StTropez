import assert from "node:assert/strict";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

/** Shared fixture mechanics; callers own review preparation, gestures and clocks. */
export function createHostScene(page) {
    let mounted = false;
    const snapshot = () => page.evaluate(() => window.hostFixture.snapshot());
    return Object.freeze({
        get mounted() { return mounted; },
        snapshot,
        ready: () => page.evaluate(() => window.hostReferenceProbe.waitReady()),
        async mount(host) {
            assert.equal(mounted, false, "Dispose the current host scene before mounting another.");
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
            mounted = true;
            await page.evaluate(installHostReferenceProbe);
        },
        async dispose() {
            if (!mounted) return;
            await page.evaluate(() => window.hostFixture.dispose()); mounted = false;
            const state = await snapshot();
            for (const key of ["views", "leases", "subscriptions"]) assert.equal(state.diagnostics[key], 0, key);
            assert.equal(state.hostSubscriptions, 0, "host subscriptions");
        },
        // This whole-document oracle belongs outside interaction clocks.
        exactText(text, target = "source") {
            assert.ok(target === "source" || target === "reference", "Select source or reference text.");
            return page.evaluate(({ text, target }) => {
                const f = window.hostFixture, state = f.snapshot();
                const length = target === "source" ? state.source.length : state.bindings.comparison?.baseline?.length;
                if (length !== text.length) return false;
                for (let from = 0; from < length; from += 32768) {
                    const to = Math.min(length, from + 32768);
                    const actual = target === "source" ? f.range(from, to) : f.referenceRange(from, to);
                    if (actual !== text.slice(from, to)) return false;
                }
                return true;
            }, { text, target });
        },
    });
}
