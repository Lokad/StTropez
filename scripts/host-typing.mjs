import assert from "node:assert/strict";

/**
 * @typedef {{start: number, type: string, beforeRevision: number, beforeDepth: number,
 * end?: number, revision?: number, depth?: number}} TypingEvent
 * @typedef {{events: TypingEvent[], blurred: boolean, beforeDepth: number, baseline: boolean}} TypingObservation
 * @typedef {typeof window & {readHostTypingHistory(): TypingObservation}} TypingWindow
 */

/**
 * Check the undo boundary after every host keystroke, including spaces.
 * @param {import('@playwright/test').Locator} input
 * @param {string} text
 * @param {() => Promise<void>} [type]
 */
export async function typeHostSuffix(input, text, type = () => input.pressSequentially(text)) {
    await input.evaluate(node => {
        /** @type {TypingEvent[]} */ const events = [];
        const listeners = new AbortController(), before = window.hostFixture.snapshot();
        /** @type {TypingEvent | undefined} */ let active;
        let blurred = false;
        node.addEventListener("input", event => { const s = window.hostFixture.snapshot(); active = { start: performance.now(), type: /** @type {InputEvent} */ (event).inputType,
            beforeRevision: s.source.revision, beforeDepth: s.history.undoDepth }; events.push(active); }, { capture: true, signal: listeners.signal });
        node.addEventListener("input", () => { const end = performance.now(), s = window.hostFixture.snapshot(); if (!active) throw new Error("Missing captured typing event."); Object.assign(active,
            { end, revision: s.source.revision, depth: s.history.undoDepth }); }, { signal: listeners.signal });
        node.addEventListener("blur", () => { blurred = true; }, { signal: listeners.signal });
        /** @type {TypingWindow} */ (window).readHostTypingHistory = () => { listeners.abort(); return { events, blurred, beforeDepth: before.history.undoDepth, baseline: before.bindings.editor === "native" }; };
    });
    try { await type(); }
    catch (error) { await input.evaluate(() => /** @type {TypingWindow} */ (window).readHostTypingHistory()).catch(() => {}); throw error; }
    const observed = await input.evaluate(() => /** @type {TypingWindow} */ (window).readHostTypingHistory());
    const characters = Array.from(text);
    assert.equal(observed.blurred, false); assert.equal(observed.events.length, characters.length);
    for (let index = 0; index < observed.events.length; index++) {
        const event = observed.events[index], previous = observed.events[index - 1];
        assert.ok(event && event.end !== undefined && event.depth !== undefined);
        assert.equal(event.type, "insertText"); assert.equal(event.revision, event.beforeRevision + 1);
        const space = characters[index] === " ", precedingSpace = characters[index - 1] === " ";
        const startsStep = !previous || (space ? !precedingSpace : precedingSpace && characters[index - 2] === " ");
        assert.equal(event.beforeDepth, previous?.depth ?? observed.beforeDepth);
        if (observed.baseline && previous) {
            // The textarea fixture still groups by time. Its timestamps fall within the handler bounds.
            assert.ok(previous.end !== undefined && previous.depth !== undefined);
            assert.ok(event.depth === previous.depth || event.depth === previous.depth + 1);
            if (event.end - previous.start < 1000) assert.equal(event.depth, previous.depth);
            if (event.start - previous.end >= 1000) assert.equal(event.depth, previous.depth + 1);
        } else assert.equal(event.depth, event.beforeDepth + Number(startsStep));
    }
    const last = observed.events.at(-1); assert.ok(last?.depth !== undefined);
    const groups = last.depth - observed.beforeDepth;
    assert.ok(groups >= 1 && groups <= observed.events.length);
    return { ...observed, groups };
}
