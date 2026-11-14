import { test, expect } from "@playwright/test";

test("copy and cut with collapsed selections leave clipboard contents and history alone", async ({ page }) => {
    await page.goto("/editing/");
    const result = await page.evaluate(() => {
        const f = window.editingFixture; f.setText("alpha beta"); f.selections([{ anchor: 1, head: 1 }, { anchor: 7, head: 7 }]); f.focus("primary");
        const before = f.snapshot(), input = document.querySelector('textarea[aria-label="Primary source"]')!, events = [];
        for (const type of ["copy", "cut"]) {
            const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            event.clipboardData!.setData("text/plain", "prior contents"); input.dispatchEvent(event);
            events.push({ prevented: event.defaultPrevented, text: event.clipboardData!.getData("text/plain") });
        }
        const after = f.snapshot(); return { events, unchanged: before.document!.revision === after.document!.revision, history: after.history!.undoDepth - before.history!.undoDepth };
    });
    expect(result).toEqual({ events: [{ prevented: false, text: "prior contents" }, { prevented: false, text: "prior contents" }], unchanged: true, history: 0 });
});

test("host-cancelled copy/cut/paste preserve captured text, clipboard ownership and selections", async ({ page }) => {
    await page.goto("/editing/");
    const result = await page.evaluate(() => {
        const f = window.editingFixture; f.setText("before\r\nend"); f.select("primary", { anchor: 3, head: 1 }); f.focus("primary");
        const input = document.querySelector('textarea[aria-label="Primary source"]')!, original = f.snapshot(), events = [];
        for (const type of ["copy", "cut", "paste"] as const) {
            input.addEventListener(type, event => { const e = event as ClipboardEvent; e.clipboardData!.setData("text/plain", "host-owned"); e.preventDefault(); }, { capture: true, once: true });
            const data = new DataTransfer(), event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }); input.dispatchEvent(event);
            events.push({ type, text: f.range(0, f.snapshot().document!.length), clipboard: event.clipboardData!.getData("text/plain"), prevented: event.defaultPrevented });
        }
        return { events, before: original.primary.selection, after: f.snapshot().primary.selection, revisionBefore: original.document!.revision, revisionAfter: f.snapshot().document!.revision, exports: f.snapshot().document!.exports };
    });
    expect(result.events).toEqual(["copy", "cut", "paste"].map(type => ({ type, text: "before\r\nend", clipboard: "host-owned", prevented: true })));
    expect(result.after).toEqual(result.before); expect(result.revisionAfter).toBe(result.revisionBefore); expect(result.exports).toBe(0);
    await page.evaluate(() => window.editingFixture.dispose()); expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});

test("empty or nontext clipboard payloads cannot turn a selected range into a deletion", async ({ page }) => {
    await page.goto("/editing/");
    const result = await page.evaluate(() => {
        const f = window.editingFixture; f.setText("before\r\nend"); f.select("primary", { anchor: 3, head: 1 }); f.focus("primary");
        const input = document.querySelector('textarea[aria-label="Primary source"]')!, before = f.snapshot();
        for (const kind of ["empty", "html", "file"] as const) {
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }), data = event.clipboardData!;
            if (kind === "empty") data.setData("text/plain", ""); if (kind === "html") data.setData("text/html", "<b>no plain text</b>");
            if (kind === "file") data.items.add(new File(["bytes"], "sample.bin", { type: "application/octet-stream" }));
            input.dispatchEvent(event);
        }
        return { text: f.range(0, f.snapshot().document!.length), revisionBefore: before.document!.revision, revisionAfter: f.snapshot().document!.revision, before: before.primary.selection, after: f.snapshot().primary.selection, exports: f.snapshot().document!.exports };
    });
    expect(result.text).toBe("before\r\nend"); expect(result.revisionAfter).toBe(result.revisionBefore); expect(result.after).toEqual(result.before); expect(result.exports).toBe(0);
    const delayed = await page.evaluate(() => {
        const f = window.editingFixture, text = "a" + " ".repeat(1000000) + "next";
        f.setText(text); f.select("primary", { anchor: 0, head: 0 }); f.focus("primary");
        const input = document.querySelector('textarea[aria-label="Primary source"]')!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
        if (!f.snapshot().primary.pendingWord) throw new Error("Word command did not yield.");
        for (const kind of ["empty", "html", "file"] as const) {
            const event = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }), data = event.clipboardData!;
            if (kind === "empty") data.setData("text/plain", "");
            if (kind === "html") data.setData("text/html", "<b>no plain text</b>");
            if (kind === "file") data.items.add(new File(["bytes"], "sample.bin", { type: "application/octet-stream" }));
            input.dispatchEvent(event);
            if (!f.snapshot().primary.pendingWord) throw new Error("Empty paste cancelled navigation.");
        }
        return f.snapshot().document!.revision;
    });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.pendingWord)).toBe(false);
    const after = await page.evaluate(() => window.editingFixture.snapshot());
    expect(after.document).toMatchObject({ revision: delayed, length: 1000005, exports: 0 });
    expect(after.primary.selection).toMatchObject({ anchor: 1000001, head: 1000001 });
    await page.evaluate(() => window.editingFixture.dispose());
});
