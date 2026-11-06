import assert from "node:assert/strict";

/** Validate real host keystrokes against the adapter's pause policy; observers never alter history. */
export async function typeHostSuffix(input, text, type = () => input.pressSequentially(text)) {
    await input.evaluate(node => {
        const events = [], listeners = new AbortController(), before = window.hostFixture.snapshot(); let active, blurred = false;
        node.addEventListener("input", event => { const s = window.hostFixture.snapshot(); active = { start: performance.now(), type: event.inputType,
            beforeRevision: s.source.revision, beforeDepth: s.history.undoDepth }; events.push(active); }, { capture: true, signal: listeners.signal });
        node.addEventListener("input", () => { const end = performance.now(), s = window.hostFixture.snapshot(); Object.assign(active,
            { end, revision: s.source.revision, depth: s.history.undoDepth }); }, { signal: listeners.signal });
        node.addEventListener("blur", () => { blurred = true; }, { signal: listeners.signal });
        globalThis.readHostTypingHistory = () => { listeners.abort(); return { events, blurred, beforeDepth: before.history.undoDepth }; };
    });
    try { await type(); }
    catch (error) { await input.evaluate(() => globalThis.readHostTypingHistory()).catch(() => {}); throw error; }
    const observed = await input.evaluate(() => globalThis.readHostTypingHistory());
    assert.equal(observed.blurred, false); assert.equal(observed.events.length, Array.from(text).length);
    for (let index = 0; index < observed.events.length; index++) {
        const event = observed.events[index], previous = observed.events[index - 1];
        assert.equal(event.type, "insertText"); assert.equal(event.revision, event.beforeRevision + 1);
        assert.ok(event.depth === event.beforeDepth || event.depth === event.beforeDepth + 1);
        if (!previous) assert.equal(event.depth, observed.beforeDepth + 1);
        // Adapter timestamps lie inside these input-handler bounds. Require coalescing when
        // a pause is impossible and a new group when a pause is certain; retain ambiguous bounds.
        else if (event.end - previous.start < 1000) assert.equal(event.depth, previous.depth);
        else if (event.start - previous.end >= 1000) assert.equal(event.depth, previous.depth + 1);
    }
    const groups = observed.events.at(-1).depth - observed.beforeDepth;
    assert.ok(groups >= 1 && groups <= observed.events.length);
    return { ...observed, groups };
}
