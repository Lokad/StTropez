import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

test("an async editor operation applies once and releases every expired or failed request", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const f = window.editingFixture; f.setText("abc");
        const ownership = () => { const d = f.snapshot().diagnostics; return [d.leases, d.subscriptions]; };
        const before = ownership(), edit = { edits: [{ from: 0, to: 1, insert: "X" }], source: "test" };
        const applied = await f.operation({ write: true }, async op => {
            await op.step(Promise.resolve("ready"));
            return [op.apply(edit), op.apply(edit)];
        });
        let cancelled = 0, continued = false;
        const delayed = f.operation({ write: true }, async op => {
            op.apply({ edits: [{ from: 0, to: 1, insert: "never" }] });
            await op.step({ result: new Promise<void>(() => {}), cancel: () => { cancelled++; } });
            continued = true; return op.apply(edit);
        });
        const retained = ownership(); f.edit([{ from: 3, to: 3, insert: "!" }]);
        const stale = await delayed;
        let providerCurrent = true;
        const withdrawn = await f.operation({ write: true }, async op => {
            await op.step(Promise.resolve({ isCurrent: () => providerCurrent }));
            op.apply({ edits: [{ from: 0, to: 1, insert: "expired" }] }); providerCurrent = false;
        });
        let error = "";
        try { await f.operation({ write: true }, op => op.apply({ edits: [{ from: -1, to: 0, insert: "" }] })); }
        catch (cause) { error = cause instanceof Error ? cause.name : String(cause); }
        const abort = new AbortController();
        const abandoned = f.operation({ signal: abort.signal }, () => new Promise<void>(() => {}));
        abort.abort(); const interrupted = await abandoned;
        const lane = f.latestOperation(), independent = f.latestOperation();
        let finish!: () => void;
        const other = independent.run({}, op => op.step(new Promise<void>(resolve => { finish = resolve; })));
        const first = lane.run({ write: true }, async op => {
            op.apply({ edits: [{ from: 0, to: 0, insert: "superseded" }] });
            await op.step(new Promise<void>(() => {}));
        });
        const second = lane.run({ signal: new AbortController().signal }, op => op.document.revision);
        finish();
        const latest = [(await first).status, (await second).status, (await other).status];
        lane.dispose(); independent.dispose();
        latest.push((await lane.run({}, () => 0)).status);
        const after = ownership(), text = f.range(0, 4);
        const replaced = f.operation({ write: true }, async op => {
            await op.step(Promise.resolve()); return op.apply(edit);
        });
        f.replacePrimary();
        return { before, retained, after, applied, stale, withdrawn, error, interrupted, cancelled, continued, text, latest, replaced: await replaced };
    });
    expect(result.applied).toEqual({ status: "completed", value: [true, false] });
    for (const outcome of [result.stale, result.withdrawn, result.interrupted, result.replaced]) expect(outcome).toEqual({ status: "stale" });
    expect(result.retained[0]).toBe(result.before[0]! + 1);
    expect(result.after).toEqual(result.before);
    expect(result.latest).toEqual(["stale", "completed", "completed", "stale"]);
    expect(result).toMatchObject({ error: "RangeError", cancelled: 1, continued: false, text: "Xbc!" });
});

const state = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());
test.beforeEach(async ({ page }) => {

    await page.goto("/editing/"); await ready(page);
});

test("whole-file edits and history keep both panes on their own visible lines", async ({ page }) => {
    const lines = Array.from({ length: 120 }, (_, i) => `row ${i + 1} abcdef\n`);
    const original = lines.join(""), replacement = original.replace("row 55 abcdef", "row 55 longer replacement");
    await page.evaluate(text => {
        const f = window.editingFixture;
        f.setText(text);
        for (const [pane, row] of [["primary", "row 27"], ["secondary", "row 84"]] as const) {
            const head = text.indexOf(row) + 2;
            f.select(pane, { anchor: head, head });
        }
    }, original);
    await ready(page);
    const positions = () => page.locator(".st-editor").evaluateAll(editors => editors.map(editor => {
        const top = editor.getBoundingClientRect().top;
        const row = Array.from(editor.querySelectorAll(".st-viewport-row")).find(el => el.getBoundingClientRect().bottom > top);
        return { top: editor.scrollTop, row: row?.textContent };
    }));
    const before = await positions();
    expect(before).toHaveLength(2);
    expect(before.every(pane => pane.top > 0 && pane.row)).toBe(true);
    await page.evaluate(({ length, replacement }) => window.editingFixture.edit([{ from: 0, to: length, insert: replacement }]), { length: original.length, replacement });
    for (const action of ["edit", "undo", "redo"] as const) {
        if (action !== "edit") await page.evaluate(action => window.editingFixture.history(action), action);
        await ready(page);
        const current = action === "undo" ? original : replacement, snapshot = await state(page);
        expect(await positions()).toEqual(before);
        expect(snapshot.primary.selection.head).toBe(current.indexOf("row 27") + 2);
        expect(snapshot.secondary.selection.head).toBe(current.indexOf("row 84") + 2);
    }
});

test("Undo groups a leading space with its word and keeps a run of spaces separate", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture; f.setText(""); f.focus("primary"); });
    const row = page.locator("#primary .st-viewport-row").first();
    await page.keyboard.type("abc def  ghi");
    for (const expected of ["abc def  ", "abc def", "abc", ""]) {
        await page.keyboard.press("Control+z"); await expect(row).toHaveJSProperty("textContent", expected);
    }
    await page.keyboard.press("Control+Shift+z"); await page.keyboard.press("End"); await page.keyboard.type("d");
    await page.keyboard.press("Control+z"); await expect(row).toHaveJSProperty("textContent", "abc");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("w".repeat(1_000_000)); f.selections([{ anchor: 0, head: 0 }]);
        const input = document.querySelector("#primary textarea")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        if (!f.snapshot().primary.pendingWord) throw new Error("Expected pending navigation.");
        for (const data of "abc def") input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data, bubbles: true, cancelable: true }));
    });
    await ready(page); await page.keyboard.press("Control+z"); await ready(page);
    expect(await page.evaluate(() => { const f = window.editingFixture; return f.range(1_000_000, f.snapshot().document!.length); })).toBe("abc");
});

test("trusted replacement input preserves UTF-16 selection across a surrogate pair", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("a😀b")); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await input.focus();
    await input.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.setSelectionRange(1, 3);
        for (const type of ["beforeinput", "input"]) input.addEventListener(type, event => {
            input.setAttribute(`data-${type}-trusted`, String(event.isTrusted));
        }, { once: true });
    });
    await input.press("x"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 3))).toBe("axb");
    expect((await state(page)).primary.selection).toMatchObject({ anchor: 2, head: 2 });
    expect(await input.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([2, 2]);
    for (const type of ["beforeinput", "input"]) await expect(input).toHaveAttribute(`data-${type}-trusted`, "true");
});

test("failed command turns release input and report the cause before later typing", async ({ page }) => {
    const text = "abcdefghij\n".repeat(80), source = page.getByRole("textbox", { name: "Primary source", exact: true });
    for (const failure of ["inline-decoration", "deferred-decoration", "queued-transform", "committed-transform", "committed-tail", "language-policy"] as const) {
        const immediate = failure === "inline-decoration" || failure === "language-policy", committed = failure.startsWith("committed-");
        await page.evaluate(({ text, failure }) => {
            const f = window.editingFixture; f.setText(text);
            f.selections(Array.from({ length: failure === "inline-decoration" || failure === "language-policy" ? 1 : 33 }, (_, i) => ({ anchor: i * 11 + 1, head: i * 11 + (failure === "language-policy" ? 2 : 1) })));
        }, { text, failure }); await ready(page); await source.focus();
        const before = await state(page);
        try { await source.evaluate((element, failure) => {
            const input = element as HTMLTextAreaElement, f = window.editingFixture;
            if (failure.endsWith("decoration")) {
                // The fault belongs to a command turn, including deferred commands. Hold native
                // frame paints until it is caught; otherwise a frame can consume the fault first.
                const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, held = new Map<number, FrameRequestCallback>(); let id = 0;
                window.requestAnimationFrame = callback => { held.set(--id, callback); return id; };
                window.cancelAnimationFrame = at => { if (!held.delete(at)) cancel.call(window, at); };
                (window as typeof window & { releaseFaultFrames?: () => void }).releaseFaultFrames = () => {
                    window.requestAnimationFrame = request;
                    try { for (const [at, callback] of held) { held.delete(at); callback(performance.now()); } }
                    finally { window.cancelAnimationFrame = cancel; held.clear(); delete (window as typeof window & { releaseFaultFrames?: () => void }).releaseFaultFrames; }
                };
            }
            if (failure === "language-policy") {
                f.configure({ language: { allowPair: () => { throw new Error("Fixture language failure"); } } });
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "(", bubbles: true, cancelable: true })); return;
            } else if (failure === "queued-transform") {
                const release = f.registerEditTransform(() => { release(); throw new Error("Fixture transform failure"); });
            } else if (failure.startsWith("committed-")) {
                const release = f.registerEditTransform(edit => ({ ...edit, complete: () => { release(); throw new Error("Fixture completion failure"); } }));
            } else f.failNextDecoration();
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
            if (failure !== "inline-decoration" && input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "queued", bubbles: true, cancelable: true }))) throw new Error("Expected queued input");
            if (failure === "committed-tail") {
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
                input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "remaining😀", bubbles: true, cancelable: true }));
            }
        }, failure);
        await expect.poll(async () => (await state(page)).conflicts.filter(item => item.reason === "command-failed").length).toBe(
            before.conflicts.filter(item => item.reason === "command-failed").length + 1);
        } finally { await page.evaluate(() => (window as typeof window & { releaseFaultFrames?: () => void }).releaseFaultFrames?.()); }
        await expect.poll(() => page.evaluate(() => { const s = window.editingFixture.snapshot().primary; return !s.pendingWord && !s.pendingGrapheme && !s.pendingInput; })).toBe(true);
        const failed = await state(page);
        expect(failed.document!.revision).toBe(before.document!.revision + (committed ? 1 : 0));
        const error = failure === "language-policy" ? "Fixture language failure" : failure === "queued-transform" ? "Fixture transform failure" : committed ? "Fixture completion failure" : "Fixture decoration failure";
        expect(failed.conflicts.at(-1)).toMatchObject({ reason: "command-failed", error });
        expect(await page.evaluate(index => window.editingFixture.conflictText(index), before.conflicts.length)).toBe(failure === "language-policy" ? "(" : failure === "committed-tail" ? "remaining😀" : !immediate && !committed ? "queued" : "");
        if (committed) expect(failed.document!.length).toBe(text.length + 33 * "queued".length);
        if (failure === "committed-tail") expect(failed.conflicts.length).toBe(before.conflicts.length + 2);
        await page.evaluate(() => { window.editingFixture.configure({ language: {} }); window.editingFixture.select("primary", { anchor: 0, head: 0 }); }); await ready(page);
        await source.pressSequentially("after"); await ready(page);
        expect(await page.evaluate(() => window.editingFixture.range(0, 5))).toBe("after");
        expect((await state(page)).conflicts).toEqual(failed.conflicts);
    }
});

test("read-only Tab traverses surrounding host controls in both directions", async ({ page }) => {
    await page.goto("/editing/?readonly"); await ready(page);
    await page.evaluate(() => {
        const root = document.querySelector("#primary .st-editor")!;
        const before = document.createElement("button"), after = document.createElement("button");
        before.textContent = "Before source"; after.textContent = "After source"; root.before(before); root.after(after);
    });
    const source = page.getByRole("textbox", { name: "Primary source", exact: true });
    await source.press("Tab"); await expect(page.getByRole("button", { name: "After source", exact: true })).toBeFocused();
    await source.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Before source", exact: true })).toBeFocused();
});

test("Apple caret chords navigate the document and full line beyond native input context", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" })); await page.reload(); await ready(page);
    const text = "one\n" + "x".repeat(4000) + "\n" + "tail\n".repeat(1000);
    await page.evaluate(text => { window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: 2004, head: 2004 }); }, text); await ready(page);
    const source = page.getByRole("textbox", { name: "Primary source", exact: true });
    for (const [key, anchor, head] of [["Meta+ArrowLeft", 4, 4], ["Meta+Shift+ArrowRight", 4, 4004],
        ["Meta+ArrowDown", text.length, text.length], ["Meta+Shift+ArrowUp", text.length, 0]] as const) {
        await source.press(key); await ready(page); expect((await state(page)).primary.selection).toMatchObject({ anchor, head });
    }
});

test("IME confirmation keycode does not invoke a language newline after compositionend", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture; f.setText("a"); f.select("primary", { anchor: 1, head: 1 }); f.configure({ language: { enter: "keep" } }); }); await ready(page);
    const source = page.getByRole("textbox", { name: "Primary source", exact: true });
    expect(await source.evaluate(node => {
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(false);
    expect(await page.evaluate(() => window.editingFixture.range(0, window.editingFixture.snapshot().document!.length))).toBe("a");
    await source.press("Enter"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 2))).toBe("a\n");
});

test("typing, newline, paste and history keep a visible caret in place on both scroll axes", async ({ page }) => {
    const source = page.getByRole("textbox", { name: "Primary source", exact: true });
    await page.evaluate(() => window.editingFixture.setText((" ".repeat(60) + "x".repeat(340) + "\n").repeat(2000))); await ready(page);
    await page.evaluate(() => {
        const f = window.editingFixture; f.configure({ language: { enter: "keep" } });
        const offset = 500 * 401 + 80; f.selections([{ anchor: offset, head: offset }]); f.focus("primary");
        const root = document.querySelector<HTMLElement>("#primary .st-viewport")!;
        root.scrollTop = f.snapshot().primary.viewport.lineHeight * 498; root.scrollLeft = 250;
        root.dispatchEvent(new Event("scroll"));
    });
    const settled = async () => {
        await ready(page);
        return page.evaluate(() => { const s = window.editingFixture.snapshot().primary; return { top: s.viewport.scrollTop, left: s.viewport.scrollLeft }; });
    };
    const before = await settled(); expect(before.top).toBeGreaterThan(1000); expect(before.left).toBe(250);
    const unchanged = async () => {
        expect(await settled()).toEqual(before);
        expect(await page.evaluate(() => {
            const f = window.editingFixture, s = f.snapshot().primary, point = f.coords(s.selection.head, s.selection.headAffinity);
            const box = document.querySelector("#primary .st-viewport")!.getBoundingClientRect();
            return !!point && point.top >= box.top && point.top + point.height <= box.bottom && point.left >= box.left && point.left <= box.right;
        })).toBe(true);
    };
    await source.press("x"); await unchanged(); await source.press("Enter"); await unchanged();
    await source.evaluate(node => { const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "p"); node.dispatchEvent(event); }); await unchanged();
    for (const key of ["Control+z", "Control+z", "Control+y", "Control+y"]) { await source.press(key); await unchanged(); }
});

test("captured host insertion uses the input transform once and expires before later typing", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("abc"); window.editingFixture.select("primary", { anchor: 1, head: 2 }); }); await ready(page);
    expect(await page.evaluate(() => {
        const f = window.editingFixture, completions: boolean[] = [];
        const stop = f.registerEditTransform(plan => ({ ...plan, edits: plan.edits.map(edit => ({ ...edit, insert: edit.insert.toUpperCase() })), complete: applied => completions.push(applied) }));
        const capture = f.captureInsertion()!, pending = f.snapshot().primary.pendingInput, settledDuringCapture = f.settled;
        const inserted = capture.insert("x"), again = capture.insert("late"); stop();
        return { pending, settledDuringCapture, inserted, again, completions, aborted: capture.signal.aborted, text: f.range(0, 3), pendingAfter: f.snapshot().primary.pendingInput };
    })).toEqual({ pending: true, settledDuringCapture: false, inserted: true, again: false, completions: [true], aborted: true, text: "aXc", pendingAfter: false });
    await page.getByRole("textbox", { name: "Primary source", exact: true }).press("Control+z"); await ready(page);
    const pending = await page.evaluateHandle(() => {
        const f = window.editingFixture, old = f.captureInsertion()!, next = f.captureInsertion()!;
        const superseded = old.signal.aborted && !old.insert("late");
        return { superseded, next };
    });
    const source = page.getByRole("textbox", { name: "Primary source", exact: true });
    await source.press("F8");
    expect(await pending.evaluate(({ next }) => next.isCurrent())).toBe(true);
    await source.press("q"); await ready(page);
    expect(await pending.evaluate(({ superseded, next }) => ({ superseded, aborted: next.signal.aborted, late: next.insert("late"),
        text: window.editingFixture.range(0, 3), pending: window.editingFixture.snapshot().primary.pendingInput })))
        .toEqual({ superseded: true, aborted: true, late: false, text: "aqc", pending: false });
    await pending.dispose();
});

test("real typing in 100k lines uses bounded native context and shared grouped undo", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.select("primary", { anchor: 1_200_000, head: 1_200_000 }); window.editingFixture.focus("primary"); }); await ready(page);
    await page.keyboard.type("xyz"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(1_200_000, 1_200_003))).toBe("xyz");
    expect((await state(page))).toMatchObject({ document: { revision: 3, length: 2_400_003, exports: 0 }, primary: { commits: 3, selection: { anchor: 1_200_003, head: 1_200_003 } }, secondary: { selection: { anchor: 0, head: 0 } }, history: { undoDepth: 1 } });
    expect((await state(page)).primary.inputUnits).toBeLessThan(2600);
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page))).toMatchObject({ document: { length: 2_400_000, exports: 0 }, primary: { selection: { head: 1_200_000 } } });
    await page.keyboard.press("ControlOrMeta+Shift+z"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(1_200_000, 1_200_003))).toBe("xyz");
    await page.keyboard.press("ControlOrMeta+a"); expect((await state(page)).primary.inputUnits).toBe(1);
    await page.keyboard.type("replacement"); await ready(page);
    expect((await state(page)).document).toMatchObject({ length: 11, exports: 0 });
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("replacement");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page)).document!.length).toBe(2_400_003);
});

test("a read-only view keeps bounded navigation and Find while its peer retains editing authority", async ({ page }) => {
    await page.goto("/editing/?readonly"); await ready(page);
    const reader = page.getByRole("textbox", { name: "Primary source", exact: true }), peer = page.getByRole("textbox", { name: "Secondary source", exact: true });
    await expect(reader).toHaveJSProperty("readOnly", true); await expect(peer).toHaveJSProperty("readOnly", false);
    const initial = await state(page);
    await reader.press("ControlOrMeta+End"); expect((await state(page)).primary.selection.head).toBe(2_400_000);
    await reader.press("ControlOrMeta+a"); expect((await state(page)).primary.inputUnits).toBe(1);
    for (const key of ["Backspace", "Delete", "Tab", "ControlOrMeta+z", "ControlOrMeta+Shift+z"]) await reader.press(key);
    await reader.pressSequentially("blocked"); await ready(page);
    expect((await state(page)).document).toEqual(initial.document); expect((await state(page)).history).toEqual(initial.history);
    expect((await state(page)).primary.viewport.rows).toBeLessThan(100);
    await page.evaluate(() => window.editingFixture.setText("alpha\r\nbeta alpha")); await ready(page);
    await page.evaluate(() => { window.editingFixture.find("alpha"); });
    await expect.poll(async () => (await state(page)).find.status).toBe("ready");
    expect(await page.evaluate(() => window.editingFixture.findNext())).toBe(true);
    const before = await state(page);
    expect(await page.evaluate(() => window.editingFixture.replaceCurrent("changed"))).toBe(false);
    await page.evaluate(() => window.editingFixture.replaceAll("changed"));
    await reader.evaluate(node => {
        const input = node as HTMLTextAreaElement;
        for (const type of ["cut", "paste", "copy"]) {
            const data = new DataTransfer(); data.setData("text/plain", type === "copy" ? "" : "blocked");
            const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }); input.dispatchEvent(event);
            if (type === "copy" && event.clipboardData!.getData("text/plain") !== "alpha") throw new Error("Read-only selection copy failed");
        }
        for (const inputType of ["insertText", "historyUndo", "historyRedo", "deleteContentBackward"]) {
            const event = new InputEvent("beforeinput", { inputType, data: "blocked", bubbles: true, cancelable: true }); input.dispatchEvent(event);
            if (!event.defaultPrevented) throw new Error("Read-only beforeinput was not refused");
        }
        // A noncancelable native change must still fail at the model commit boundary.
        input.setRangeText("blocked", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" }));
        const data = new DataTransfer(); data.setData("text/plain", "blocked");
        for (const type of ["dragenter", "dragover", "drop"]) input.parentElement!.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    }); await ready(page);
    expect((await state(page)).document).toEqual(before.document); expect((await state(page)).history).toEqual(before.history);
    expect(await page.evaluate(() => window.editingFixture.range(0, 17))).toBe("alpha\r\nbeta alpha");
    expect((await state(page)).conflicts.slice(-2).map(c => c.reason)).toEqual(["read-only", "read-only"]);
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 0, head: 5 })); await ready(page);
    const transfer = await reader.evaluate(node => {
        const root = node.parentElement!, selected = root.querySelector(".st-viewport-selected")!, rect = selected.getBoundingClientRect();
        selected.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 77, pointerType: "mouse", button: 0, clientX: rect.left + 1, clientY: rect.top + rect.height / 2 }));
        const data = new DataTransfer(); Object.defineProperty(data, "effectAllowed", { value: "uninitialized", writable: true });
        const start = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }); root.dispatchEvent(start);
        const target = document.querySelector("#secondary .st-editor")!, box = target.getBoundingClientRect();
        for (const type of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 15, clientY: box.top + 15 }));
        document.dispatchEvent(new Event("dragend")); return { refused: start.defaultPrevented, effect: data.effectAllowed };
    });
    expect(transfer).toEqual({ refused: false, effect: "copy" }); await ready(page);
    expect((await state(page)).document!.length).toBe(before.document!.length + 5);
    await peer.press("ControlOrMeta+z"); await ready(page); expect((await state(page)).document!.length).toBe(before.document!.length);
    await peer.press("ControlOrMeta+Home"); await peer.pressSequentially("!"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("!alpha");
    const edited = await state(page); await reader.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page)).document).toEqual(edited.document); expect((await state(page)).history).toEqual(edited.history);
    await peer.press("ControlOrMeta+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 5))).toBe("alpha");
    await reader.press("Escape"); await reader.press("Tab"); await expect(peer).toBeFocused();
    await page.evaluate(() => window.editingFixture.dispose()); expect((await state(page)).diagnostics).toMatchObject({ resources: 0, views: 0, leases: 0, subscriptions: 0 });
});

test("measured tab/CJK/cluster coordinates drive pointer selection and whole-grapheme deletion", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("a\t界é👩‍💻z\r\nsecond")); await ready(page);
    const points = await page.evaluate(() => [1, 2, 3, 4, 5, 10, 11].map(offset => window.editingFixture.coords(offset)!));
    expect(points[1]!.left - points[0]!.left).toBeGreaterThan(points[2]!.left - points[1]!.left);
    expect(points[3]!.offset).toBe(5); // A caret inside a combining sequence snaps to its boundary.
    for (const point of points) expect(await page.evaluate(p => window.editingFixture.hit(p.left, p.top + p.height / 2)?.offset, point)).toBe(point.offset);
    const point = points[4]!; await page.mouse.click(point.left, point.top + point.height / 2);
    expect((await state(page)).primary.selection.head).toBe(5);
    await page.keyboard.press("Backspace"); expect(await page.evaluate(() => window.editingFixture.range(0, 17))).toBe("a\t界👩‍💻z\r\nsecond");
    await page.keyboard.press("Delete"); expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("a\t界z\r\nsecond");
    await page.keyboard.press("End"); await page.keyboard.press("ArrowRight");
    expect((await state(page)).primary.selection.head).toBe(6); // CRLF moves as one grapheme.
    await page.keyboard.press("Backspace"); expect(await page.evaluate(() => window.editingFixture.range(0, 10))).toBe("a\t界zsecond");
});

test("plain-text paste uses local line endings across a large backward selection", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.select("primary", { anchor: 2_300_000, head: 100_000 }); window.editingFixture.focus("primary"); });
    expect((await state(page)).primary.inputUnits).toBe(513);
    await page.getByRole("textbox", { name: "Primary source" }).evaluate(input => {
        const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        event.clipboardData!.setData("text/plain", "A\r\nB");
        if (event.clipboardData!.getData("text/plain") !== "A\r\nB") throw new Error("Synthetic clipboard fixture lost its data.");
        input.dispatchEvent(event);
    }); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(100_000, 100_003))).toBe("A\nB");
    expect((await state(page))).toMatchObject({ document: { length: 200_003, exports: 0 }, primary: { selection: { anchor: 100_003, head: 100_003 } } });
    await page.keyboard.press("ControlOrMeta+z"); await ready(page); expect((await state(page)).document!.length).toBe(2_400_000);
});

test("pasting at mixed line endings respects each caret and the host's literal option", async ({ page }) => {
    for (const mode of ["local", "preserve"]) {
        if (mode === "preserve") await page.goto("/editing/?pasteLineEndings=preserve");
        await page.evaluate(() => {
            const f = window.editingFixture; f.setText("a\r\nb\nc"); f.focus("primary");
            f.selections([{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]);
        });
        await ready(page);
        await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(input => {
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            event.clipboardData!.setData("text/plain", "1\r2\n"); input.dispatchEvent(event);
        });
        const text = await page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); });
        expect(text).toBe(mode === "local" ? "1\r\n2\r\na\r\n1\n2\nb\nc" : "1\r2\na\r\n1\r2\nb\nc");
    }
});

test("synthetic composition commits once and rejects stale, readonly and expired captured targets", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("alpha omega"); window.editingFixture.select("primary", { anchor: 6, head: 11 }); window.editingFixture.focus("primary"); }); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source" });
    const start = async () => input.evaluate(node => {
        const input = node as HTMLTextAreaElement; input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
    });
    const end = async () => input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
    await start(); expect((await state(page)).primary.commits).toBe(0); await end(); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 8))).toBe("alpha 東京"); expect((await state(page)).primary.commits).toBe(1);
    for (const reason of ["stale-revision", "read-only", "expired-view"]) {
        await start();
        await page.evaluate(reason => {
            if (reason === "stale-revision") window.editingFixture.edit([{ from: 0, to: 0, insert: "host " }]);
            if (reason === "read-only") window.editingFixture.readOnly(true);
            if (reason === "expired-view") window.editingFixture.replacePrimary();
        }, reason);
        await end();
        expect((await state(page)).conflicts.at(-1)).toMatchObject({ reason });
        expect(await page.evaluate(() => window.editingFixture.conflictText())).toContain("東京");
        if (reason === "read-only") await page.evaluate(() => window.editingFixture.readOnly(false));
    }
    expect((await state(page)).primary.commits).toBe(1);
    expect((await state(page)).secondary.viewport.revision).toBe((await state(page)).document!.revision);
});

test("two views retain text and selections through persisted transitions, then dispose on final hide", async ({ page }, info) => {
    info.annotations.push({ type: "page-transition-policy", description: "Synthetic persisted/final events; native back/forward-cache qualification remains external." });
    await page.evaluate(() => { window.editingFixture.setText("first\nsecond"); window.editingFixture.select("secondary", { anchor: 6, head: 12 }); window.editingFixture.focus("primary"); }); await ready(page);
    const before = await state(page), primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await primary.evaluate(node => { node.dataset.retained = "yes"; });
    for (let index = 0; index < 2; index++) {
        await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        const retained = await state(page); expect(retained.disposed).toBe(false); expect(retained.document).toEqual(before.document);
        expect(retained.primary.selection).toEqual(before.primary.selection); expect(retained.secondary.selection).toEqual(before.secondary.selection);
        await expect(primary).toHaveAttribute("data-retained", "yes");
    }
    await page.keyboard.type("!"); await ready(page);
    expect((await state(page)).secondary.selection).toMatchObject({ anchor: 7, head: 13 });
    await page.keyboard.press("Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 5))).toBe("!   f");
    await page.keyboard.press("Escape"); await page.keyboard.press("Tab"); await expect(page.getByRole("textbox", { name: "Secondary source" })).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    expect((await state(page)).diagnostics).toMatchObject({ resources: 0, documents: 0, views: 0, subscriptions: 0, leases: 0 });
    expect((await state(page)).primary).toMatchObject({ disposed: true, inputUnits: 0, viewport: { disposed: true, pending: false } });
    expect(await page.locator("textarea, .st-viewport").count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
});

test("typed closers distinguish an automatically inserted delimiter at each caret", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture; f.setText("\n)"); f.selections([{ anchor: 0, head: 0 }]); f.focus("primary"); });
    await page.keyboard.type("(");
    await page.evaluate(() => window.editingFixture.selections([{ anchor: 1, head: 1 }, { anchor: 3, head: 3 }]));
    await page.keyboard.type(")"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 5))).toBe("()\n))");
    await page.evaluate(() => window.editingFixture.selections([{ anchor: 1, head: 1 }]));
    await page.keyboard.type(")x");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", "()x)");
});

test("Backspace removes an automatic pair through a mapped edit and undo, but leaves a literal closer", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture; f.setText("a"); f.selections([{ anchor: 1, head: 1 }]); f.focus("primary"); });
    await page.keyboard.type("(");
    await page.evaluate(() => window.editingFixture.edit([{ from: 0, to: 0, insert: "b" }]));
    const row = page.locator("#primary .st-viewport-row").first();
    await page.keyboard.press("Control+Backspace"); await expect(row).toHaveJSProperty("textContent", "ba");
    await page.keyboard.press("Control+z"); await expect(row).toHaveJSProperty("textContent", "ba()");
    await page.keyboard.press("Backspace"); await expect(row).toHaveJSProperty("textContent", "ba");
    await page.keyboard.press("Control+z");
    await page.evaluate(() => { const f = window.editingFixture;
        f.edit([{ from: 2, to: 3, insert: "[" }]); f.edit([{ from: 2, to: 3, insert: "(" }]); f.selections([{ anchor: 3, head: 3 }]);
    });
    await page.keyboard.press("Backspace"); await page.keyboard.type("X");
    await expect(row).toHaveJSProperty("textContent", "baX)");
});

test("line indentation/outdent, CRLF Enter, paired brackets and vertical navigation use model selections", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("one\n\ttwo\nthree"); window.editingFixture.select("primary", { anchor: 0, head: 9 }); window.editingFixture.focus("primary"); }); await ready(page);
    await page.keyboard.press("Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("    one\n    \ttwo\nthree");
    await page.keyboard.press("Shift+Tab"); expect(await page.evaluate(() => window.editingFixture.range(0, 14))).toBe("one\n\ttwo\nthree");
    await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("End"); await page.keyboard.type("(");
    expect(await page.evaluate(() => window.editingFixture.range(14, 16))).toBe("()");
    await page.keyboard.type(")"); expect((await state(page)).document!.length).toBe(16); expect((await state(page)).primary.selection.head).toBe(16);
    await page.keyboard.press("ControlOrMeta+Home"); await ready(page); await page.keyboard.press("ArrowDown");
    expect((await state(page)).primary.selection.head).toBe(4);
    await page.keyboard.press("ArrowUp"); expect((await state(page)).primary.selection.head).toBe(0);
    await page.evaluate(() => {
        window.editingFixture.configure({ language: { tabSize: 4 } });
        window.editingFixture.setText("  \tone\r\nnext");
        window.editingFixture.select("primary", { anchor: 6, head: 6 }); window.editingFixture.focus("primary");
    }); await ready(page);
    await page.keyboard.press("Shift+Tab"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 9))).toBe("one\r\nnext");
    expect((await state(page)).primary.selection.head).toBe(3);
    await page.keyboard.press("Enter"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("one\r\n\r\nnext");
    expect((await state(page)).primary.selection.head).toBe(5);
    await page.keyboard.press("ControlOrMeta+z"); await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("  \tone\r\nnext");
    expect((await state(page)).primary.selection.head).toBe(6);
    await page.keyboard.press("ControlOrMeta+Shift+z"); await page.keyboard.press("ControlOrMeta+Shift+z"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("one\r\n\r\nnext");
    expect((await state(page)).primary.selection.head).toBe(5);
});

test("comment chords and shifted slash act on the captured lines", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture;
        f.configure({ language: { tabSize: 2, lineComment: "//", blockComment: { open: "/*", close: "*/" } } });
        f.setText("  alpha\n// beta"); f.focus("primary");
    });
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const rows = page.locator("#primary .st-viewport-row");
    const stroke = (key: string, shiftKey = false) => input.evaluate((node, args) =>
        !node.dispatchEvent(new KeyboardEvent("keydown", { ...args, ctrlKey: true, bubbles: true, cancelable: true })), { key, shiftKey });
    await input.press("Control+a"); await input.press("Control+k"); expect(await stroke("c")).toBe(true);
    await expect(rows).toHaveText(["  // alpha", "// beta"]);
    await input.press("Control+k"); await input.press("Control+u"); await expect(rows).toHaveText(["  alpha", "beta"]);
    await page.evaluate(() => window.editingFixture.selections([{ anchor: 3, head: 5 }]));
    await input.press("Control+]"); await expect(rows.first()).toHaveJSProperty("textContent", "    alpha");
    await input.press("Control+["); await expect(rows.first()).toHaveJSProperty("textContent", "  alpha");
    expect(await stroke("/", true)).toBe(true); await expect(rows.first()).toHaveJSProperty("textContent", "  // alpha");
    expect(await stroke("/", true)).toBe(true);
    await input.press("Shift+Alt+a"); await expect(rows.first()).toHaveJSProperty("textContent", "  a/*lp*/ha");
    await input.press("Control+k"); await page.evaluate(() => window.editingFixture.selections([{ anchor: 0, head: 0 }]));
    expect(await stroke("c")).toBe(false);
});

test("a rebound chord belongs to its editor and leaves host field editing local", async ({ page }) => {
    const keys = await page.evaluate(() => {
        window.editingFixture.setText("abc");
        const { commands, keymap } = window.editingFixture;
        const field = document.createElement("input"); document.body.append(field); field.focus();
        let calls = 0, enabled = true;
        const command = commands.register({ id: "sample.action", label: "Sample action", enabled: () => enabled, run: () => { calls++; } });
        const keys = "Ctrl+k Ctrl+j";
        const old = keymap.bind(keys, "sample.action", { shared: true });
        keymap.unbind(keys); keymap.bind(keys, "sample.action", { shared: true }); old.dispose();
        const forward = (event: KeyboardEvent) => { keymap.handle(event); };
        field.addEventListener("keydown", forward);
        document.body.addEventListener("keydown", forward);
        const press = (key: string, isComposing = false) => !field.dispatchEvent(new KeyboardEvent("keydown", {
            key, ctrlKey: true, cancelable: true, bubbles: true, isComposing,
        }));
        try {
            const prefix = press("k"), chord = press("j");
            press("k"); field.blur(); field.focus(); const afterBlur = press("j");
            press("k"); window.editingFixture.selections([{ anchor: 1, head: 1 }]); const afterMove = press("j");
            const local = press("d"), composing = press("k", true);
            enabled = false; const disabled = commands.run("sample.action");
            const listed = commands.list().find(entry => entry.id === "sample.action");
            command.dispose();
            return { prefix, chord, afterBlur, afterMove, local, composing, disabled, listed, retired: commands.run("sample.action"), calls };
        } finally { command.dispose(); document.body.removeEventListener("keydown", forward); field.remove(); }
    });
    expect(keys).toEqual({ prefix: true, chord: true, afterBlur: false, afterMove: false, local: false, composing: false, disabled: false,
        listed: { id: "sample.action", label: "Sample action", enabled: false }, retired: false, calls: 1 });
});

test("popup bindings fall back in priority order and roll back conflicts without replacing the owner", async ({ page }) => {
    await page.goto("/editing/");
    expect(await page.evaluate(() => {
        const { commands, keymap } = window.editingFixture, calls: string[] = [];
        const press = (key: string) => keymap.handle(new KeyboardEvent("keydown", { key, cancelable: true }));
        const lower = commands.register({ id: "test.find", label: "Close Find", run: () => { calls.push("find"); } },
            { keys: ["Escape"], shared: true });
        let open = false;
        const higher = commands.register({ id: "test.popup", label: "Dismiss popup", run: () => { calls.push("popup"); return open; } },
            { keys: ["Escape"], priority: 5, shared: true });
        let conflict = false;
        try { commands.register({ id: "test.rejected", label: "Duplicate", run: () => { calls.push("rejected"); } },
            { keys: ["F8", "Escape"], priority: 5, shared: true }); } catch { conflict = true; }
        const partial = commands.get("test.rejected") !== undefined || press("F8");
        press("Escape"); open = true; press("Escape"); higher.dispose(); press("Escape"); lower.dispose();
        return { calls, conflict, partial, after: press("Escape") };
    })).toEqual({ calls: ["popup", "find", "popup", "find"], conflict: true, partial: false, after: false });
});

test("Alt arrows move and copy lines while typing and Undo follow the selected block", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture; f.setText("a\r\nb\nc"); f.selections([{ anchor: 4, head: 3 }]); f.focus("primary"); });
    const rows = page.locator("#primary .st-viewport-row");
    await page.keyboard.press("Alt+ArrowUp"); await expect(rows).toHaveText(["b", "a", "c"]);
    await page.keyboard.press("Alt+Shift+ArrowDown"); await page.keyboard.type("B");
    await expect(rows).toHaveText(["b", "B", "a", "c"]);
    await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z");
    await expect(rows).toHaveText(["a", "b", "c"]); expect((await state(page)).primary.selection).toMatchObject({ anchor: 4, head: 3 });
});

test("inserting lines above and below, deleting at EOF and Undo keep typing on the intended row", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture;
        f.configure({ language: { enter: "keep" } }); f.setText("  a\r\nend"); f.selections([{ anchor: 6, head: 6 }]); f.focus("primary");
    });
    const rows = page.locator("#primary .st-viewport-row");
    await page.keyboard.press("Control+Shift+Enter"); await expect(rows.nth(1)).toHaveJSProperty("textContent", "  ");
    await page.keyboard.press("Control+End"); await page.keyboard.press("Control+Enter"); await page.keyboard.type("last");
    await expect(rows).toHaveText(["a", "", "end", "last"]); await expect(rows.nth(1)).toHaveJSProperty("textContent", "");
    await page.keyboard.press("Control+Shift+k"); await page.keyboard.type("!");
    await expect(rows.last()).toHaveJSProperty("textContent", "end!");
    await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z");
    await expect(rows.last()).toHaveJSProperty("textContent", "last");
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
});

test("typing a closing brace realigns the line and Undo restores its indentation", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture, text = "  if (ok) {\n      ";
        f.setText(text); f.selections([{ anchor: text.length, head: text.length }]); f.focus("primary");
    });
    await page.keyboard.type("}");
    const row = page.locator("#primary .st-viewport-row").nth(1);
    await expect(row).toHaveJSProperty("textContent", "  }");
    await page.keyboard.press("Control+z"); await expect(row).toHaveJSProperty("textContent", "      ");
    await page.keyboard.type("x}"); await expect(row).toHaveJSProperty("textContent", "      x}");
});

test("leaving an automatically indented blank line trims it with the next edit", async ({ page }) => {
    await page.evaluate(() => { const f = window.editingFixture;
        f.configure({ language: { enter: "keep" } }); f.setText("  a\r\nz"); f.selections([{ anchor: 3, head: 3 }]); f.focus("primary");
    });
    const text = () => page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); });
    await page.keyboard.press("Enter"); expect(await text()).toBe("  a\r\n  \r\nz");
    await page.keyboard.press("Control+End"); expect(await text()).toBe("  a\r\n  \r\nz");
    await page.keyboard.type("!"); expect(await text()).toBe("  a\r\n\r\nz!");
    await page.keyboard.press("Control+z"); expect(await text()).toBe("  a\r\n  \r\nz");
    await page.evaluate(() => { const f = window.editingFixture; f.edit([{ from: 0, to: 0, insert: "#" }]); f.selections([{ anchor: 8, head: 8 }]); });
    await page.keyboard.press("Enter"); expect(await text()).toBe("#  a\r\n\r\n  \r\nz");
    await page.keyboard.type(" "); await page.keyboard.press("Control+End"); await page.keyboard.type("?");
    expect(await text()).toBe("#  a\r\n\r\n   \r\nz?");
    await expect(page.locator("#primary .st-viewport-row").last()).toHaveJSProperty("textContent", "z?");
});

test("very long graphemes delete whole and stale yielding indentation cannot retarget later input", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x" + "\u0301".repeat(5000)); window.editingFixture.select("primary", { anchor: 5001, head: 5001 }); window.editingFixture.focus("primary"); });
    await page.keyboard.press("Backspace"); await expect.poll(async () => (await state(page)).document!.length).toBe(0);
    await page.keyboard.press("ControlOrMeta+z"); expect((await state(page)).document!.length).toBe(5001);
    await page.evaluate(() => {
        window.editingFixture.load("lines-100000"); window.editingFixture.select("primary", { anchor: 0, head: 2_400_000 });
        const input = document.querySelector("#primary textarea")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        window.editingFixture.edit([{ from: 0, to: 0, insert: "later " }]);
    });
    await expect.poll(async () => (await state(page)).primary.pendingGrapheme).toBe(false);
    expect((await state(page)).document!.length).toBe(2_400_006);
    expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("later ");
});

test("yielding multiline indentation publishes one reversible transaction", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x\n".repeat(1024)); window.editingFixture.select("primary", { anchor: 0, head: 2048 }); window.editingFixture.focus("primary"); });
    const before = await state(page); await page.keyboard.press("Tab");
    await expect.poll(async () => (await state(page)).document!.length).toBe(6144);
    expect((await state(page)).document!.revision).toBe(before.document!.revision + 1);
    expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("    x\n    x\n");
    await page.keyboard.press("ControlOrMeta+z"); await ready(page);
    expect((await state(page)).document!.length).toBe(2048); expect((await state(page)).primary.selection).toMatchObject({ anchor: 0, head: 2048 });
});

test("configured commands retain native ordering and expire on configuration changes", async ({ page }) => {
    await page.evaluate(() => {
        window.editingFixture.configure({ language: { tabSize: 2, lineComment: "//" } });
        window.editingFixture.setText("x\n".repeat(4096)); window.editingFixture.select("primary", { anchor: 0, head: 8192 });
        window.editingFixture.focus("primary");
        window.editingFixture.command("line-comment");
        if (!window.editingFixture.snapshot().primary.pendingCommand) throw new Error("Expected deferred comment planning");
        const input = document.querySelector<HTMLTextAreaElement>("#primary textarea")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "(", bubbles: true }));
        input.setRangeText("(", input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "(", bubbles: true }));
        const enter = new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true });
        input.dispatchEvent(enter); if (!enter.defaultPrevented) throw new Error("Expected configured Enter capture");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        const event = new InputEvent("beforeinput", { inputType: "insertText", data: "z", bubbles: true, cancelable: true });
        input.dispatchEvent(event); if (!event.defaultPrevented) throw new Error("Expected captured input");
    });
    await expect.poll(async () => (await state(page)).primary.pendingInput).toBe(false);
    expect((await state(page)).conflicts).toEqual([]);
    expect(await page.evaluate(() => window.editingFixture.range(20475, 20485))).toBe("// x\n(\n  z");
    await page.evaluate(() => {
        window.editingFixture.setText("x\n".repeat(4096)); window.editingFixture.select("primary", { anchor: 0, head: 8192 });
        window.editingFixture.command("line-comment");
        if (!window.editingFixture.snapshot().primary.pendingCommand) throw new Error("Expected deferred comment planning");
        window.editingFixture.configure({ language: { tabSize: 4 } });
    });
    await expect.poll(async () => (await state(page)).primary.pendingCommand).toBe(false);
    expect((await state(page)).document!.length).toBe(8192);
    expect(await page.locator("#primary .st-viewport").evaluate(node => getComputedStyle(node).tabSize)).toBe("4");
});

test("short shaped rows grow horizontal extent and a later revision discards obsolete measurements", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("界".repeat(512))); await ready(page);
    const large = (await state(page)).primary.viewport;
    expect(large.horizontalExtent).toBeGreaterThan(512 * large.columnWidth + 24);
    await page.evaluate(() => window.editingFixture.setText("x")); await ready(page);
    const small = (await state(page)).primary.viewport;
    expect(small.horizontalExtent).toBeLessThan(small.width); expect(small.physicalWidth).toBe(small.width);
});

test("browser-protocol composition commits one bounded edit without qualifying native IME", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium CDP composition; native-device IME remains a separate gate on every engine.");
    await page.evaluate(() => { window.editingFixture.setText("alpha omega"); window.editingFixture.select("primary", { anchor: 6, head: 11 }); window.editingFixture.focus("primary"); }); await ready(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    expect((await state(page)).primary).toMatchObject({ composing: true, commits: 0 });
    await cdp.send("Input.insertText", { text: "日本語" }); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 9))).toBe("alpha 日本語");
    expect((await state(page)).primary).toMatchObject({ composing: false, commits: 1, selection: { head: 9 } });
    await page.keyboard.press("ControlOrMeta+z"); expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("alpha omega");
    await cdp.detach();
});
