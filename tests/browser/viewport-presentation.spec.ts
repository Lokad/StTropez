import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Workspace, ResourceId, TabId } from "../../src/index.ts";
import type { TextEditor, TextComparison } from "../../src/browser/index.ts";
import { fontFixture } from "../fixtures/consumer/font-fixture.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; host: HTMLElement; tab: TabId; resource: ResourceId; comparison?: TextComparison };
declare global { interface Window { presentationFixture: Fixture } }

let modules: Map<string, string>, css: string;
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
test.beforeAll(async () => {
    const built = await build({ entryPoints: { core: "src/index.ts", browser: "src/browser/index.ts" }, outdir: "artifacts/presentation-fixture",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text])); css = await readFile("src/browser/editor.css", "utf8");
});
test.beforeEach(async ({ page }) => {
    await page.route("**/presentation-fixture/*.js", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return route.fulfill({ contentType: "text/javascript", body: modules.get(name)! });
    });
    await page.goto("/presentation-fixture/");
    await page.addStyleTag({ content: css });
});

test("definition lookup releases its source when the provider has no free scope", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, createNavigationController, mountTextEditor, openWebSocketTransport } =
            await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Source",
            { value: "const catalogue = 1;\ncatalogue" }, undefined, { language: { uri: "fixture:/source", languageId: "generic" } });
        const host = document.createElement("main"); host.style.height = "240px"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, source.documentId);
        const connect = (signal: AbortSignal) => openWebSocketTransport("ws://" + location.host + "/lsp-fixture", { signal });
        const provider = new BrowserLspWorkspace(workspace, { maxScopes: 1, connect });
        const occupied = provider.createScope();
        let pointerHits = 0;
        const navigation = createNavigationController(editor, provider, { linkAt() { pointerHits++; return undefined; } });
        const ownership = () => { const { leases, subscriptions } = workspace.diagnostics(); return { leases, subscriptions }; };
        const retired = new BrowserLspWorkspace(workspace, { connect });
        retired.dispose();
        let refused = false, retiredHits = 0;
        try { createNavigationController(editor, retired, { linkAt() { retiredHits++; return undefined; } }); }
        catch { refused = true; }
        return { ownership, pointerHits: () => pointerHits, status: () => navigation.getSnapshot().status,
            retiredMount: () => ({ refused, retiredHits }),
            lookup: () => navigation.request("definition", 23).then(result => result.locationAt(0)?.from, (error: Error) => error.message),
            freeScope: occupied.dispose,
            finish() { navigation.dispose(); provider.dispose(); editor.dispose(); } };
    });
    const before = await fixture.evaluate(f => f.ownership());
    const row = page.locator(".st-viewport-row").filter({ hasText: "const catalogue" });
    await expect(row).toBeVisible();
    const point = await paintedCharacter(row, "catalogue", 2);
    await page.keyboard.down("Control"); await page.mouse.move(point.x, point.y);
    await expect.poll(() => fixture.evaluate(f => f.pointerHits())).toBeGreaterThan(0);
    await page.keyboard.up("Control");
    expect(await fixture.evaluate(f => f.retiredMount())).toEqual({ refused: true, retiredHits: 0 });
    expect(await fixture.evaluate(f => f.ownership())).toEqual(before);
    expect(await fixture.evaluate(f => f.lookup())).toContain("scope limit");
    expect(await fixture.evaluate(f => f.status())).toBe("failed");
    expect(await fixture.evaluate(f => f.ownership())).toEqual(before);
    await fixture.evaluate(f => f.freeScope());
    expect(await fixture.evaluate(f => f.lookup())).toBe(6);
    await fixture.evaluate(f => f.finish());
    expect(await fixture.evaluate(f => f.ownership())).toEqual({ leases: 0, subscriptions: 0 });
});

test("signature help can release focus to a host field and recover from a refused mount", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { BrowserLspWorkspace, createSignatureController, mountTextEditor, openWebSocketTransport } =
            await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), text = 'lookup("key", )';
        const source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Source",
            { value: text }, undefined, { language: { uri: "fixture:/source", languageId: "generic" } });
        const host = document.createElement("main"), field = document.createElement("input");
        host.style.height = "240px"; field.setAttribute("aria-label", "Host field"); document.body.append(host, field);
        const editor = mountTextEditor(host, workspace, source.documentId, { ariaLabel: "Source" });
        const caret = text.indexOf(")"); editor.view.setSelection(0, { anchor: caret, head: caret }); editor.focus();
        const connect = (signal: AbortSignal) => openWebSocketTransport("ws://" + location.host + "/lsp-fixture", { signal });
        const provider = new BrowserLspWorkspace(workspace, { connect, maxScopes: 1 });
        let signature = createSignatureController(editor, provider);
        signature.subscribe(() => { if (signature.getSnapshot().status === "ready") field.focus(); });
        return { status: () => signature.getSnapshot().status,
            tryRetired() {
                signature.dispose();
                const retired = new BrowserLspWorkspace(workspace, { connect }); retired.dispose();
                try { createSignatureController(editor, retired); } catch (error) { return String(error); }
            },
            registered: () => editor.commands.list().filter(command => command.id.startsWith("signature.")).map(command => command.id),
            remount() { signature = createSignatureController(editor, provider); editor.focus(); },
            requestAfterBlur() { field.focus(); editor.focus(); signature.request(); },
            finish() { editor.dispose(); provider.dispose(); },
            owners() { const { views, subscriptions, leases } = workspace.diagnostics(); return { views, subscriptions, leases }; } };
    });
    const source = page.getByRole("textbox", { name: "Source" }), field = page.getByRole("textbox", { name: "Host field" });
    await source.press("Control+Shift+Space");
    await expect(field).toBeFocused();
    await page.keyboard.type("ok"); await expect(field).toHaveValue("ok");
    expect(await fixture.evaluate(f => f.status())).toBe("idle");
    expect(await fixture.evaluate(f => f.tryRetired())).toContain("disposed");
    expect(await fixture.evaluate(f => f.registered())).toEqual([]);
    await fixture.evaluate(f => f.remount());
    await source.press("Control+Shift+Space");
    await expect.poll(() => fixture.evaluate(f => f.status())).toBe("ready");
    await fixture.evaluate(f => f.requestAfterBlur());
    await expect.poll(() => fixture.evaluate(f => f.status())).toBe("ready");
    await fixture.evaluate(f => f.finish());
    expect(await fixture.evaluate(f => f.owners())).toEqual({ views: 0, subscriptions: 0, leases: 0 });
});

test("document mounts own Find, fold discovery and pending insertions across a remount", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, createFindController, createFoldingController } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "document", variant: "working" }, "Source", { value: "one\n  two\nend" });
        const view = workspace.createDocumentView(source.documentId);
        const host = document.createElement("main");
        host.style.height = "240px"; document.body.append(host);
        const mount = () => mountTextEditor(host, workspace, source.documentId, { view });
        const editor = mount(), find = createFindController(editor);
        let reply: (() => void) | undefined, discoverySignal: AbortSignal | undefined;
        const folds = createFoldingController(editor, (_document, signal) => {
            discoverySignal = signal;
            return new Promise(resolve => { reply = () => resolve([{ from: 0, to: 9 }]); });
        }, { delayMs: 0 });
        find.setQuery("two");
        let replacement: typeof editor;
        return {
            ready: () => !!reply && find.getSnapshot().status === "ready",
            replace: () => {
                if (!find.next()) throw new Error("Could not select the match.");
                const insertion = editor.captureInsertion();
                if (!insertion) throw new Error("Could not capture the selected text.");
                editor.dispose();
                replacement = mount(); replacement.focus(); reply!();
                return { tabs: workspace.diagnostics().tabs, expired: insertion.signal.aborted && !insertion.insert("stale"),
                    cancelled: discoverySignal?.aborted, find: find.getSnapshot().status, folds: folds.getSnapshot().status };
            },
            finish: () => {
                const text = workspace.document(source.documentId).buffer.text(), ranges = view.folding.getSnapshot().regions.length;
                replacement.dispose(); view.dispose(); workspace.releaseResource(source.id, true);
                return { text, ranges, ...workspace.diagnostics() };
            }
        };
    });
    await expect.poll(() => fixture.evaluate(f => f.ready())).toBe(true);
    expect(await fixture.evaluate(f => f.replace())).toEqual({ tabs: 0, expired: true, cancelled: true, find: "disposed", folds: "disposed" });
    await expect(page.getByRole("textbox", { name: "Source" })).toBeFocused();
    await page.keyboard.type("ok");
    await expect(page.locator(".st-viewport")).toContainText("ok");
    expect(await fixture.evaluate(f => f.finish())).toMatchObject({ text: "one\n  ok\nend", ranges: 0, tabs: 0, views: 0, leases: 0, subscriptions: 0 });
});

test("cancelling a refresh makes the same selection editable before the stale reply settles", async ({ page }) => {
    const fixture = await page.evaluateHandle(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const source = workspace.createTextResource({ scope: "test", resource: "refresh", variant: "working" }, "Source", { value: "left middle right" });
        const host = document.createElement("main"); document.body.append(host);
        const editor = mountTextEditor(host, workspace, source.documentId);
        editor.view.setSelection(0, { anchor: 11, head: 5 });
        const refresh = workspace.operations.beginLoad(source);
        return { cancel: refresh.cancel, late: () => refresh.accept({ value: "obsolete" }), dispose: editor.dispose };
    });
    const input = page.getByRole("textbox", { name: "Source" });
    await expect(input).toBeDisabled(); await fixture.evaluate(f => f.cancel());
    await expect(input).toBeEnabled();
    await input.focus(); await page.keyboard.type("X"); await expect(input).toHaveValue("left X right");
    expect(await fixture.evaluate(f => f.late())).toBe(false);
    await input.press("Control+z"); await expect(input).toHaveValue("left middle right");
    await fixture.evaluate(f => f.dispose()); await fixture.dispose();
});

test("remounting after edits uses the retained selection, maps a fresh view or clamps older captures", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const file = workspace.createTextResource({ scope: "test", resource: "restore", variant: "working" }, "Source", { value: "left\nmiddle\nright" });
        const id = file.documentId, view = workspace.createDocumentView(id);
        const host = document.createElement("main"); host.style.height = "160px"; document.body.append(host);
        let editor = mountTextEditor(host, workspace, id, { view });
        try {
            view.setSelections(0, [{ anchor: 1, head: 1 }, { anchor: 16, head: 13 }], 1);
            editor.viewport.flush();
            const capture = editor.captureView();
            const saved = { ...capture, horizontalAnchor: { revision: 0, offset: 13, affinity: "before" as const, left: 15 } };
            editor.dispose();
            workspace.edit({ documentId: id, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 5, insert: "" }] });
            editor = mountTextEditor(host, workspace, id);
            let observedTop: number | undefined;
            const stop = editor.view.subscribe(() => { observedTop = editor.viewport.captureView().scrollTop; });
            const mapped = editor.restoreView({ ...saved, scrollTop: 17 }), first = editor.view.getSnapshot().selectionSet;
            stop();
            editor.dispose();
            workspace.edit({ documentId: id, expectedRevision: 1, origin: "host", edits: [{ from: 2, to: 12, insert: "" }] });
            editor = mountTextEditor(host, workspace, id);
            const clamped = editor.restoreView(saved), second = editor.view.getSnapshot().selectionSet;
            const wrong = { ...saved, folding: { ...saved.folding!, documentId: workspace.createTextResource(
                { scope: "test", resource: "other", variant: "working" }, "Other", { value: "" }).documentId } };
            const foreign = editor.restoreView(wrong);
            editor.dispose();
            editor = mountTextEditor(host, workspace, id, { view });
            const live = view.getSnapshot().selectionSet, kept = editor.restoreView(saved);
            const retained = live === view.getSnapshot().selectionSet;
            const here = editor.captureView(); view.setSelection(2, { anchor: 1, head: 1 });
            const exact = editor.restoreView(here, { selection: "current" });
            return { observedTop, mapped: mapped?.selection, mappedAnchors: [mapped?.verticalAnchorRestored, mapped?.horizontalAnchorRestored],
                droppedAnchors: [clamped?.verticalAnchorRestored, clamped?.horizontalAnchorRestored], first: first.ranges.map(r => [r.anchor, r.head]), primary: first.primary,
                clamped: clamped?.selection, second: second.ranges.map(r => [r.anchor, r.head]), foreign, kept: kept?.selection,
                retained, sameRevision: exact?.selection, caret: view.getSnapshot().selection.head };
        } finally { editor.dispose(); view.dispose(); host.remove(); }
    });
    expect(result).toEqual({ observedTop: 17, mapped: "mapped", mappedAnchors: [true, true], droppedAnchors: [false, false], first: [[0, 0], [11, 8]], primary: 1, clamped: "clamped", second: [[1, 1], [2, 2]],
        foreign: null, kept: "current", retained: true, sameRevision: "current", caret: 1 });
});

test("Back restores the origin selections across edits at a same-file destination", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor, createNavigationHistory } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const { documentId } = workspace.createTextResource({ scope: "test", resource: "jump", variant: "source" }, "Jump",
            { value: "abc\norigin line\n" });
        const host = document.body.appendChild(document.createElement("section"));
        const editor = mountTextEditor(host, workspace, documentId), history = createNavigationHistory(workspace);
        try {
            const { view } = editor, revision = workspace.document(documentId).revision;
            view.setSelections(revision, [{ anchor: 10, head: 4 }, { anchor: 13, head: 13 }], 1);
            const origin = history.capture(editor)!;
            origin.visit(() => view.setSelection(revision, { anchor: 1, head: 1 }));
            for (const insert of ["xx", "y"]) workspace.edit({ documentId, expectedRevision: workspace.document(documentId).revision,
                edits: [{ from: 1, to: 1, insert }], origin: "human" });
            const restored = history.back(() => editor);
            const { ranges, primary } = view.getSnapshot().selectionSet;
            return { restored, primary, ranges: ranges.map(({ anchor, head }) => [anchor, head]), depth: history.getSnapshot() };
        } finally { history.dispose(); editor.dispose(); host.remove(); }
    });
    expect(result).toEqual({ restored: "restored", primary: 1, ranges: [[13, 7], [16, 16]], depth: 0 });
});

test("revealing a source range in a read-only editor aligns the painted rows and preserves the caller's focus", async ({ page }) => {
    const result = await page.evaluate(async () => {
        const path = "/presentation-fixture/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace();
        const resource = workspace.createTextResource({ scope: "test", resource: "reveal", variant: "working" }, "Source",
            { value: Array.from({ length: 200 }, (_, i) => "row " + i + " 😀").join("\r\n") });
        const host = document.createElement("main"), other = document.createElement("button");
        host.style.height = "200px"; document.body.append(other, host);
        const editor = mountTextEditor(host, workspace, resource.documentId, { readOnly: true });
        try {
            const { view, viewport } = editor, { buffer, revision } = workspace.document(resource.documentId);
            view.setSelections(revision, [{ anchor: 5, head: 1 }, { anchor: 7, head: 7 }], 0);
            const selection = view.getSnapshot().selectionSet, folding = view.folding;
            folding.setRanges(folding.getSnapshot(), [{ id: "section", from: buffer.offsetAt(12), to: buffer.offsetAt(160), collapsed: true }]);
            viewport.flush(); other.focus();
            const origin = editor.captureView(), row = buffer.line(80);
            const stale = editor.reveal(row, { expectedRevision: revision + 1, select: true, focus: true });
            let rejected = false;
            try { editor.reveal({ from: row.to, to: row.from }, { select: true, focus: true }); } catch (error) { rejected = error instanceof RangeError; }
            const untouched = view.getSnapshot().selectionSet === selection && folding.getSnapshot().index.collapsedCount === 1 && document.activeElement === other;
            const point = editor.reveal({ line: 80, column: 999 }, { align: "start" });
            viewport.flush(); const start = viewport.getSnapshot().scrollTop;
            const preview = point?.from === row.to && point.to === row.to && !!viewport.coordsAt(row.to)
                && view.getSnapshot().selectionSet === selection && document.activeElement === other && folding.getSnapshot().index.collapsedCount === 0;
            editor.reveal(row); viewport.flush(); const kept = viewport.getSnapshot().scrollTop === start;
            const selected = editor.reveal(row, { align: "center", select: true, focus: true, expectedRevision: revision });
            viewport.flush(); const centered = viewport.getDiagnostics();
            const centerDelta = start - centered.scrollTop;
            const center = Math.abs(centerDelta - (centered.height - centered.lineHeight) / 2) < centered.lineHeight;
            const chosen = selected?.from === row.from && selected.to === row.to && view.getSnapshot().selection.head === row.to
                && view.getSnapshot().selection.anchor === row.from && editor.getSnapshot().focused;
            const eof = editor.reveal({ line: 999, column: 999 });
            editor.restoreView(origin); viewport.flush();
            const returned = viewport.getSnapshot().scrollTop === origin.scrollTop && view.getSnapshot().selection.anchor === 5 && view.getSnapshot().selection.head === 1
                && view.getSnapshot().selectionSet.ranges.length === 2;
            return { stale, rejected, untouched, preview, kept, center, chosen, eof: eof?.from === buffer.length, returned };
        } finally { editor.dispose(); other.remove(); host.remove(); }
    });
    expect(result).toEqual({ stale: null, rejected: true, untouched: true, preview: true, kept: true, center: true, chosen: true, eof: true, returned: true });
});

test("minimap gestures preserve focus and multiple selections as the document projection changes", async ({ page }) => {
    const selection = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), lines = Array.from({ length: 200 }, (_, i) => i < 75 || i > 150 ? "    section " + i : "");
        lines[0] = "x".repeat(200);
        const resource = workspace.createTextResource({ scope: "test", resource: "map", variant: "text" }, "Map", { value: lines.join("\n") });
        const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "map"), host = document.createElement("section");
        host.style.cssText = "width:410.5px;height:240.5px;zoom:1.25"; document.body.append(host);
        const editor = mountTextEditor(host, workspace, tab), viewport = editor.viewport;
        window.presentationFixture = { workspace, resource: resource.id, host, tab, editor };
        if (viewport.settings().minimap || host.querySelector("canvas")) throw new Error("Expected an opt-in overview.");
        viewport.configure({ minimap: true });
        editor.view.setSelections(workspace.document(resource.documentId).revision, [{ anchor: 6, head: 2 }, { anchor: 9, head: 9 }], 0);
        editor.focus(); viewport.flush();
        return editor.view.getSnapshot().selectionSet;
    });
    const track = page.locator(".st-minimap"), marker = track.locator(".st-minimap-marker"), canvas = track.locator("canvas");
    const bitmap = () => canvas.evaluate(c => (c as HTMLCanvasElement).toDataURL());
    await expect.poll(() => canvas.evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);
    const original = await bitmap(), trackBox = (await track.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => window.presentationFixture.editor.viewport.hitTest(x + 5, y + 5), trackBox)).toBeUndefined();
    const snapshot = () => page.evaluate(() => window.presentationFixture.editor.viewport.getDiagnostics());
    await page.mouse.click(trackBox.x + 8, trackBox.y + trackBox.height / 2);
    await expect.poll(async () => (await snapshot()).firstLine).toBeGreaterThan(80);
    expect((await snapshot()).lastLine).toBeLessThan(120);
    const grabbed = (await marker.boundingBox())!;
    await page.mouse.move(grabbed.x + 6, grabbed.y + 3); await page.mouse.down();
    await page.mouse.move(grabbed.x - 80, trackBox.y + trackBox.height + 5, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await snapshot()).lastLine).toBe(200);
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selectionSet)).toEqual(selection);
    await expect(page.getByRole("textbox")).toBeFocused();
    expect(await bitmap()).toBe(original);
    await page.evaluate(() => {
        const { editor, workspace } = window.presentationFixture, doc = workspace.document(editor.view.documentId);
        editor.view.setSelection(doc.revision, { anchor: doc.buffer.offsetAt(80), head: doc.buffer.offsetAt(80) });
        editor.viewport.revealOffset(doc.buffer.offsetAt(80));
    });
    await page.keyboard.insertText("new section\nsecond line");
    await expect.poll(bitmap).not.toBe(original);
    await page.getByRole("textbox").press("Control+z");
    await expect.poll(bitmap).toBe(original);
    await page.evaluate(() => {
        const { editor, workspace, host } = window.presentationFixture, doc = workspace.document(editor.view.documentId);
        editor.view.folding.setRanges(editor.view.folding.getSnapshot(), [{ id: "block", from: 0, to: doc.buffer.offsetAt(195), collapsed: true }]);
        host.style.height = "300px"; editor.viewport.flush();
    });
    await expect.poll(async () => (await snapshot()).visibleLines).toBe(6);
    await expect.poll(async () => (await marker.boundingBox())!.height).toBeCloseTo((await track.boundingBox())!.height, 0);
    await expect.poll(bitmap).not.toBe(original);
    await page.evaluate(() => {
        const { editor } = window.presentationFixture, folds = editor.view.folding;
        folds.setCollapsed(folds.getSnapshot(), "block", false); editor.viewport.scrollTo({ left: 10000 }); editor.viewport.flush();
    });
    // Expanding the fold restores the native scrollbar. Its resize observation updates the map width.
    await expect.poll(async () => (await track.boundingBox())!.width).toBeCloseTo(trackBox.width, 0);
    const resized = (await track.boundingBox())!;
    expect(Math.abs(resized.x + resized.width - trackBox.x - trackBox.width)).toBeLessThanOrEqual(1.5);
    await page.mouse.click(resized.x + 3, resized.y + resized.height - 1);
    await expect.poll(async () => (await snapshot()).lastLine).toBe(200);
    expect((await snapshot()).scrollLeft).toBeGreaterThan(0);
    const released = await page.evaluate(() => {
        const { editor, host } = window.presentationFixture, view = editor.viewport;
        view.configure({ minimap: false }); view.flush(); editor.dispose();
        return { nodes: host.childNodes.length, enabled: view.settings().minimap, accepted: view.configure({ minimap: true }) };
    });
    expect(released).toEqual({ nodes: 0, enabled: false, accepted: false });
});

test("minimap projects comparison gaps and follows linked and independent scroll in the read-only reference", async ({ page }) => {
    await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const lines = Array.from({ length: 160 }, (_, i) => "section " + i);
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "map-review", variant: "text" }, "Working", { value: lines.join("\n") });
        const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "review"), host = document.createElement("section");
        host.style.width = "900px"; document.body.append(host); lines.splice(40, 0, ...Array<string>(80).fill("baseline section"));
        const comparison = mountTextComparison(host, workspace, tab, { buffer: TextBuffer.from(lines.join("\n")), version: "one" }, { rowsAligned: true, settings: { minimap: true } });
        window.presentationFixture = { workspace, host, tab, resource: resource.id, editor: comparison.panes.working, comparison };
    });
    await page.waitForFunction(() => window.presentationFixture.editor.viewport.activity().aligned);
    const maps = page.locator(".st-minimap"), saved = maps.first(), working = maps.last();
    const bandHasInk = (map: typeof saved) => map.locator("canvas").evaluate(element => {
        const c = element as HTMLCanvasElement;
        return c.width ? c.getContext("2d")!.getImageData(0, Math.round(c.height / 3), c.width, 10).data.some((v, i) => i % 4 === 3 && v > 0) : undefined;
    });
    await expect.poll(() => bandHasInk(saved)).toBe(true); await expect.poll(() => bandHasInk(working)).toBe(false);
    await page.evaluate(() => {
        const pane = window.presentationFixture.editor.viewport;
        pane.scrollTo({ top: 70 * pane.getSnapshot().lineHeight }); pane.flush();
    });
    await page.waitForFunction(() => {
        const panes = window.presentationFixture.comparison!.panes;
        const a = panes.working.viewport.getSnapshot(), b = panes.reference.viewport.getSnapshot();
        return a.lineFrom === a.lineTo && b.lineFrom > 40 && b.lineTo < 120 && Math.abs(a.scrollTop - b.scrollTop) < 2;
    });
    const box = (await saved.boundingBox())!;
    await page.mouse.click(box.x + 5, box.y + box.height * .8);
    await page.waitForFunction(() => { const c = window.presentationFixture.comparison!, ref = c.panes.reference.viewport.getDiagnostics(), work = c.panes.working.viewport.getDiagnostics();
        return ref.firstLine > 140 && Math.abs(ref.scrollTop - work.scrollTop) < 2; });
    const independent = await page.evaluate(() => {
        const c = window.presentationFixture.comparison!; c.setRowsAligned(false); c.setScrollLinked(false);
        const reference = c.panes.reference, doc = window.presentationFixture.workspace.document(reference.view.documentId);
        reference.view.folding.setRanges(reference.view.folding.getSnapshot(), [{ id: "saved", from: 0, to: doc.buffer.offsetAt(39), collapsed: true }]);
        reference.viewport.flush(); c.panes.working.viewport.flush();
        return { workingTop: c.panes.working.viewport.getSnapshot().scrollTop, readOnly: reference.getSnapshot().readOnlyReason === "read-only", selection: reference.view.getSnapshot().selectionSet };
    });
    expect(independent.readOnly).toBe(true);
    await saved.click({ position: { x: 5, y: 1 } });
    await page.waitForFunction(() => window.presentationFixture.comparison!.panes.reference.viewport.getSnapshot().scrollTop === 0);
    const result = await page.evaluate(() => { const c = window.presentationFixture.comparison!;
        return { work: c.panes.working.viewport.getDiagnostics(), ref: c.panes.reference.viewport.getDiagnostics(), selection: c.panes.reference.view.getSnapshot().selectionSet }; });
    expect(result.work.scrollTop).toBeCloseTo(independent.workingTop, 0); expect(result.work.visibleLines).toBe(160);
    expect(result.ref.visibleLines).toBe(202); expect(result.selection).toEqual(independent.selection);
});

test.describe("scrolling beyond the last line", () => {
    test("trailing space follows visible rows and scaled extents while editing keeps the visible caret stable", async ({ page }, info) => {
        const initial = await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "trailing-space", variant: "text" }, "Trailing space", { value: "head\nbody\nend" });
            const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "trailing-space"), host = document.createElement("section");
            host.style.cssText = "height:240.4px;width:600.4px;zoom:1.25"; document.body.append(host);

            const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Trailing source" }), viewport = editor.viewport;
            window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            const defaults = viewport.settings().scrollBeyondLastLine, ordinary = viewport.getDiagnostics(), selection = editor.view.getSnapshot().selectionSet;
            viewport.configure({ scrollBeyondLastLine: true }); viewport.flush();
            const preserved = viewport.getSnapshot().scrollTop === ordinary.scrollTop, enabled = viewport.getDiagnostics();
            viewport.scrollTo({ top: 1e12 }); viewport.flush(); const end = viewport.getDiagnostics(), last = host.querySelector('.st-viewport-row[data-line="2"]')!.getBoundingClientRect();
            const layer = host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
            viewport.configure({ scrollBeyondLastLine: false }); viewport.flush();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush(); const restored = viewport.getDiagnostics();
            const renders = restored.renders; viewport.configure({ scrollBeyondLastLine: false }); viewport.flush();
            return { defaults, ordinary, enabled, end, topError: Math.abs((last.top - layer.top) / 1.25 - 12), preserved,
                restored, sameSelection: selection === editor.view.getSnapshot().selectionSet, noOpRenders: viewport.getDiagnostics().renders - renders, pending: viewport.activity().pending };
        });
        expect(initial).toMatchObject({ defaults: false, preserved: true, sameSelection: true, noOpRenders: 0, pending: false });
        expect(initial.ordinary.verticalExtent).toBeCloseTo(3 * initial.ordinary.lineHeight + 24, 5);
        expect(initial.enabled.verticalExtent).toBeCloseTo(2 * initial.enabled.lineHeight + initial.enabled.height, 5);
        expect(initial.end.scrollTop).toBeCloseTo(2 * initial.end.lineHeight, 5); expect(initial.topError).toBeLessThan(.05);
        expect(initial.restored.verticalExtent).toBe(initial.ordinary.verticalExtent); expect(initial.restored.scrollTop).toBe(0);

        const scaled = await page.evaluate(async () => {
            const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
            f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: doc.buffer.length, insert: "x\n".repeat(110000) + "end" }] });
            viewport.element.style.fontSize = "20px"; viewport.element.style.lineHeight = "2"; f.host.style.height = "300.4px";
            viewport.configure({ scrollBeyondLastLine: true }); viewport.flush();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            // Drive the native scrollbar to its physical end, then let its scroll event map back.
            viewport.element.scrollTop = viewport.element.scrollHeight;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
            const s = viewport.getDiagnostics();
            const current = f.workspace.document(doc.id), end = current.buffer.length;
            f.editor.view.setSelection(current.revision, { anchor: end, head: end }); viewport.flush();
            const caret = viewport.coordsAt(end)!, layer = f.host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
            const below = viewport.hitTest(caret.left, layer.bottom - 20);
            return { s, topError: Math.abs((viewport.rowBounds(110000)!.top - layer.top) / 1.25 - 12), hit: below?.offset, end,
                horizontalOverflow: viewport.element.scrollWidth - viewport.element.clientWidth };
        });
        expect(scaled.s.verticalExtent).toBeGreaterThan(4_000_000); expect(scaled.s.physicalHeight).toBe(4_000_000);
        expect(scaled.s.rows).toBeLessThan(16); expect(scaled.s.textUnits).toBeLessThan(40); expect(scaled.topError).toBeLessThan(1.01);
        expect(scaled.hit).toBe(scaled.end); expect(scaled.horizontalOverflow).toBe(0);
        const source = page.getByRole("textbox", { name: "Trailing source", exact: true });
        const before = await page.evaluate(() => window.presentationFixture.editor.viewport.getSnapshot().scrollTop);
        await source.press("A"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="110000"]')).toHaveText("endA");
        expect(await page.evaluate(() => window.presentationFixture.editor.viewport.getSnapshot().scrollTop)).toBeCloseTo(before, 4);
        await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="110000"]')).toHaveText("end");
        expect(await page.evaluate(() => window.presentationFixture.editor.viewport.getSnapshot().scrollTop)).toBeCloseTo(before, 4);
        await info.attach("trailing-space", { body: await page.screenshot(), contentType: "image/png" });
        const folded = await page.evaluate(() => {
            const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
            f.editor.view.folding.setRanges(f.editor.view.folding.getSnapshot(), [{ id: "body", from: 0, to: doc.buffer.offsetAt(110000), collapsed: true }]); viewport.flush();
            viewport.scrollTo({ top: 1e12 }); viewport.flush(); const s = viewport.getDiagnostics();
            viewport.configure({ scrollBeyondLastLine: false }); viewport.flush(); const clamped = viewport.getSnapshot().scrollTop;
            f.editor.dispose(); return { s, clamped, rejected: !viewport.configure({ scrollBeyondLastLine: true }), reset: !viewport.settings().scrollBeyondLastLine, nodes: f.host.childNodes.length, views: f.workspace.diagnostics().views };
        });
        expect(folded.s.visibleLines).toBe(2); expect(folded.s.scrollTop).toBeCloseTo(folded.s.lineHeight, 5);
        expect(folded).toMatchObject({ clamped: 0, rejected: true, reset: true, nodes: 0, views: 0 });
        await info.attach("trailing-space-geometry", { body: JSON.stringify({ initial, scaled, folded }), contentType: "application/json" });
    });

    test("aligned review applies trailing space independently against the shared visual grid", async ({ page }) => {
        await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "aligned-trailing", variant: "text" }, "Working", { value: "a\nb\nc" });
            const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "review"), host = document.createElement("section");
            host.style.cssText = "height:500px;width:800px"; document.body.append(host);
            const comparison = mountTextComparison(host, workspace, tab, { buffer: TextBuffer.from("extra\na\nb\nc"), version: "one" }, { rowsAligned: true });
            window.presentationFixture = { workspace, resource: resource.id, host, tab, comparison, editor: comparison.panes.working };
        });
        await page.waitForFunction(() => { const c = window.presentationFixture.comparison!;
            return c.controller.getSnapshot().status === "ready" && c.getDiagnostics().rowsAligned && !c.panes.working.viewport.activity().pending && !c.panes.reference.viewport.activity().pending; });
        const result = await page.evaluate(() => {
            const f = window.presentationFixture, c = f.comparison!, working = c.panes.working.viewport, reference = c.panes.reference.viewport;
            working.configure({ scrollBeyondLastLine: true }); working.scrollTo({ top: 1e12 }); working.flush();
            const independent = !reference.settings().scrollBeyondLastLine, grid = working.getDiagnostics();
            reference.configure({ scrollBeyondLastLine: true }); reference.scrollTo({ top: 1e12 }); reference.flush();
            const top = (viewport: typeof working, line: number) => viewport.rowBounds(line)!.top - viewport.element.querySelector(".st-viewport-layer")!.getBoundingClientRect().top;
            const workingTop = top(working, 2), referenceTop = top(reference, 3), rows = reference.getDiagnostics().visualRows;
            working.configure({ scrollBeyondLastLine: false }); working.flush();
            const clamped = working.getSnapshot().scrollTop, retained = reference.settings().scrollBeyondLastLine; c.dispose();
            return { independent, grid, rows, workingTop, referenceTop, clamped, retained, views: f.workspace.diagnostics().views };
        });
        expect(result).toMatchObject({ independent: true, rows: 4, clamped: 0, retained: true, views: 0 });
        expect(result.grid.visualRows).toBe(4); expect(result.grid.scrollTop).toBeCloseTo(3 * result.grid.lineHeight, 5);
        expect(result.workingTop).toBeCloseTo(12, 1); expect(result.referenceTop).toBeCloseTo(12, 1);
    });

    test("empty and single-row documents stay stable in fractional classic-scrollbar viewports", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
            const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
            const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "empty-trailing", variant: "text" }, "Empty", { value: "" });
            const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "empty"), host = document.createElement("section");
            host.style.cssText = "height:240.6px;width:600.6px;zoom:1.25"; document.body.append(host);
            const editor = mountTextEditor(host, workspace, tab, { settings: { scrollBeyondLastLine: true } }), viewport = editor.viewport;
            const samples: { width: number; height: number; overflow: boolean; extent: number; lineHeight: number }[] = [];
            for (const value of ["", "single"]) {
                viewport.configure({ minimap: value === "single" });
                const doc = workspace.document(resource.documentId);
                if (value) workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: 0, insert: value }] });
                for (let i = 0; i < 12; i++) {
                    await new Promise(resolve => requestAnimationFrame(resolve)); viewport.flush(); const s = viewport.getDiagnostics(), root = viewport.element;
                    samples.push({ width: root.clientWidth, height: root.clientHeight, overflow: root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight, extent: s.verticalExtent, lineHeight: s.lineHeight });
                }
            }
            const enabled = viewport.settings().scrollBeyondLastLine; editor.dispose(); return { samples, enabled, nodes: host.childNodes.length, views: workspace.diagnostics().views };
        });
        expect(result).toMatchObject({ enabled: true, nodes: 0, views: 0 });
        expect(result.samples.every(sample => !sample.overflow && sample.extent === sample.lineHeight + 24)).toBe(true);
        expect(new Set(result.samples.map(sample => `${sample.width}:${sample.height}`)).size).toBe(1);
    });
});

test("ligature policy changes native shaping while preserving caret, selection, input and ownership", async ({ page }, info) => {
    const initial = await page.evaluate(async bytes => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const face = new FontFace("StLigatureFixture", new Uint8Array(bytes)); await face.load(); document.fonts.add(face);
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "ligatures", variant: "text" }, "Ligatures", { value: "fi AB\nfi" });
        const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "ligatures"), host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px;--st-font:StLigatureFixture;--st-font-size:40px"; document.body.append(host);

        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Ligature source" }), viewport = editor.viewport;
        window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
        const selection = editor.view.getSnapshot().selectionSet, child = host.querySelector('.st-viewport-row[data-line="0"]')!.firstChild!;
        const sample = () => {
            viewport.flush(); const row = host.querySelector('.st-viewport-row[data-line="0"]')!, range = document.createRange();
            range.setStart(row.firstChild!, 0); range.setEnd(row.firstChild!, 2); const width = range.getBoundingClientRect().width;
            const points = [0, 1, 2].map(offset => {
                range.setStart(row.firstChild!, offset); range.collapse(true); const native = range.getClientRects()[0]!, point = viewport.coordsAt(offset)!;
                return { offset, left: point.left, error: Math.abs(point.left - native.left), hit: viewport.hitTest(point.left, point.top + point.height / 2)?.offset };
            });
            return { enabled: viewport.settings().fontLigatures, css: getComputedStyle(row).fontVariantLigatures, width, points };
        };
        const off = sample(); viewport.configure({ fontLigatures: true }); const on = sample();
        viewport.configure({ fontLigatures: false }); const restored = sample(); viewport.configure({ fontLigatures: true }); const again = sample();
        const observer = new MutationObserver(() => {}); observer.observe(viewport.element, { subtree: true, childList: true, attributes: true });
        const renders = viewport.getDiagnostics().renders; viewport.configure({ fontLigatures: true }); viewport.flush();
        const noOp = { mutations: observer.takeRecords().length, renders: viewport.getDiagnostics().renders - renders, pending: viewport.activity().pending }; observer.disconnect();
        return { off, on, restored, again, noOp, enabled: viewport.settings().fontLigatures, sameChild: child === host.querySelector('.st-viewport-row[data-line="0"]')!.firstChild,
            sameSelection: selection === editor.view.getSnapshot().selectionSet, revision: workspace.document(resource.documentId).revision };
    }, Array.from(fontFixture({ ligatures: true })));
    expect(initial).toMatchObject({ enabled: true, sameChild: true, sameSelection: true, revision: 0,
        noOp: { mutations: 0, renders: 0, pending: false }, off: { enabled: false, css: "none" }, on: { enabled: true, css: "normal" } });
    expect(initial.off.width).toBeCloseTo(24, 1); expect(initial.on.width).toBeCloseTo(20, 1);
    expect(initial.restored).toEqual(initial.off); expect(initial.again).toEqual(initial.on);
    for (const sample of [initial.off, initial.on]) {
        expect(sample.points.map(point => point.hit)).toEqual([0, 1, 2]);
        expect(sample.points[1]!.left).toBeGreaterThan(sample.points[0]!.left);
        expect(sample.points[1]!.left).toBeLessThan(sample.points[2]!.left);
        for (const point of sample.points) expect(point.error).toBeLessThan(1.01);
    }
    expect(initial.on.points[1]!.left).not.toBe(initial.off.points[1]!.left);
    const source = page.getByRole("textbox", { name: "Ligature source", exact: true });
    await source.press("Control+Home"); await source.press("ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(1);
    await source.press("A"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fAi AB");
    await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fi AB");
    await source.press("Shift+ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection)).toMatchObject({ anchor: 1, head: 2 });
    await source.press("Backspace"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("f AB");
    await source.press("Control+z"); await expect(page.locator('.st-viewport-layer .st-viewport-row[data-line="0"]')).toHaveText("fi AB");
    const selected = await page.evaluate(() => {
        const { editor, workspace, host } = window.presentationFixture, viewport = editor.viewport;
        editor.view.setSelection(workspace.document(editor.view.documentId).revision, { anchor: 0, head: 2 }); viewport.flush();
        const row = host.querySelector('.st-viewport-row[data-line="0"]')!, range = document.createRange(); range.selectNodeContents(row.firstChild!);
        const width = range.getBoundingClientRect().width, points = [0, 1, 2].map(offset => viewport.coordsAt(offset)!);
        return { width, text: row.firstChild!.textContent, hits: points.map(point => viewport.hitTest(point.left, point.top + point.height / 2)?.offset) };
    });
    expect(selected).toMatchObject({ text: "fi", hits: [0, 1, 2] }); expect(selected.width).toBeCloseTo(20, 1);
    await info.attach("ligature-selection", { body: await page.screenshot(), contentType: "image/png" });
    const disposed = await page.evaluate(async () => {
        const f = window.presentationFixture, viewport = f.editor.viewport;
        f.editor.dispose(); const disabled = !viewport.settings().fontLigatures, rejected = !viewport.configure({ fontLigatures: true });
        const path = "/presentation-fixture/", { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const second = mountTextEditor(f.host, f.workspace, f.tab, { settings: { fontLigatures: true } }); second.viewport.flush();
        const mounted = second.viewport.settings().fontLigatures, css = getComputedStyle(second.element).fontVariantLigatures; second.dispose();
        return { disabled, rejected, mounted, css, nodes: f.host.childNodes.length, views: f.workspace.diagnostics().views };
    });
    expect(disposed).toEqual({ disabled: true, rejected: true, mounted: true, css: "normal", nodes: 0, views: 0 });
});

test("column rulers follow measured scroll/font/zoom without changing source geometry, extent or ownership", async ({ page }, info) => {
    const initial = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "rulers", variant: "text" }, "Rulers", { value: ("x".repeat(200) + "\n").repeat(1000) });
        const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "rulers"), host = document.createElement("section");
        host.style.cssText = "height:240px;width:600px"; document.body.append(host);
        for (const columns of [[0], [-1], [1.5], [Infinity], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array(1), Array(129).fill(80)]) {
            const before = workspace.diagnostics().views;
            try { mountTextEditor(host, workspace, tab, { settings: { columnRulers: columns } }); throw new Error("Invalid rulers accepted."); }
            catch (error) { if (!(error instanceof RangeError)) throw error; }
            if (workspace.diagnostics().views !== before || host.childNodes.length) throw new Error("Invalid mount leaked ownership.");
        }
        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Ruler source" }), viewport = editor.viewport;
        window.presentationFixture = { workspace, editor, host, tab, resource: resource.id };
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle."); };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        settle(); const plain = viewport.getDiagnostics(), point = viewport.coordsAt(20)!, row = host.querySelector('.st-viewport-row[data-line="0"]')!, child = row.firstChild;
        const plainExtent = [plain.horizontalExtent, plain.verticalExtent, viewport.element.scrollWidth, viewport.element.scrollHeight];
        const defaults = viewport.settings().columnRulers;
        const configured = [40, 20, 40, 1_000_000]; viewport.configure({ columnRulers: configured }); configured[0] = 1; viewport.flush();
        const after = viewport.getDiagnostics(), captured = viewport.settings().columnRulers, guide = host.querySelector<HTMLElement>('.st-column-ruler[data-column="20"]')!;
        const range = document.createRange(); range.setStart(child!, 20); range.collapse(true); const native = range.getClientRects()[0]!;
        const observer = new MutationObserver(() => {}); observer.observe(viewport.element, { subtree: true, childList: true, attributes: true });
        viewport.configure({ columnRulers: [1_000_000, 40, 20, 20] }); viewport.flush();
        const noOp = { same: captured === viewport.settings().columnRulers, mutations: observer.takeRecords().length, pending: viewport.activity().pending }; observer.disconnect();
        let invalid = false; try { viewport.configure({ columnRulers: [20, 0] }); } catch { invalid = true; }
        return { defaults, columns: captured, frozen: Object.isFrozen(captured), invalid, preservedPolicy: captured === viewport.settings().columnRulers, noOp,
            point, afterPoint: viewport.coordsAt(20), sameChild: child === row.firstChild, text: row.textContent,
            guideError: Math.abs(guide.getBoundingClientRect().left - native.left), nativeLeft: native.left, guideLeft: guide.getBoundingClientRect().left,
            placementError: Math.abs(guide.getBoundingClientRect().left - viewport.element.getBoundingClientRect().left - after.gutterWidth - 12 - 20 * after.columnWidth), plain, after,
            pointer: getComputedStyle(guide).pointerEvents,
            visible: host.querySelectorAll(".st-column-ruler").length, plainExtent,
            afterExtent: [after.horizontalExtent, after.verticalExtent, viewport.element.scrollWidth, viewport.element.scrollHeight],
            click: { x: guide.getBoundingClientRect().left, y: point.top + point.height / 2 } };
    });
    await info.attach("initial-ruler-geometry", { body: JSON.stringify(initial), contentType: "application/json" });
    expect(initial).toMatchObject({ defaults: [], columns: [20, 40, 1_000_000], frozen: true, invalid: true, preservedPolicy: true,
        noOp: { same: true, mutations: 0, pending: false }, sameChild: true, text: "x".repeat(200), pointer: "none", visible: 2 });
    expect(initial.afterExtent).toEqual(initial.plainExtent); expect(initial.afterPoint).toEqual(initial.point);
    // Some native collapsed ranges round to whole CSS pixels; the measured ruler remains fractional.
    expect(initial.guideError).toBeLessThan(1.01); expect(initial.placementError).toBeLessThan(.02);
    await info.attach("column-rulers", { body: await page.screenshot(), contentType: "image/png" });
    await page.mouse.click(initial.click.x, initial.click.y);
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(20);
    await page.getByRole("textbox", { name: "Ruler source", exact: true }).press("ArrowRight");
    expect(await page.evaluate(() => window.presentationFixture.editor.view.getSnapshot().selection.head)).toBe(21);

    const changes = await page.evaluate(async () => {
        const f = window.presentationFixture, viewport = f.editor.viewport;
        const rows: { name: string; error: number; columnWidth: number; inside: boolean; physicalWidth: number; textUnits: number; rows: number }[] = [];
        const settle = () => { for (let i = 0; i < 8; i++) { viewport.flush(); if (!viewport.activity().pending) return; } throw new Error("Viewport did not settle."); };
        const measure = (name: string) => {
            settle(); const s = viewport.getDiagnostics(), guide = f.host.querySelector<HTMLElement>('.st-column-ruler[data-column="40"]')!;
            const row = f.host.querySelector<HTMLElement>(`.st-viewport-row[data-line="${Math.max(0, s.firstLine)}"]`)!;
            const range = document.createRange(); range.setStart(row.firstChild!, 40); range.collapse(true); const rect = range.getClientRects()[0]!;
            rows.push({ name, error: Math.abs(guide.getBoundingClientRect().left - rect.left) / Number(f.host.style.zoom || 1), columnWidth: s.columnWidth,
                inside: guide.getBoundingClientRect().top >= viewport.element.getBoundingClientRect().top - .1, physicalWidth: viewport.element.scrollWidth,
                textUnits: s.textUnits, rows: s.rows });
        };
        viewport.scrollTo({ left: 150, top: 300 }); measure("scroll");
        f.host.style.zoom = "1.25"; measure("zoom");
        viewport.element.style.fontSize = "18px"; measure("font");
        f.host.style.width = "480px"; measure("resize");
        const retained = f.host.querySelector('.st-column-ruler[data-column="40"]'); viewport.scrollTo({ top: 500 }); settle();
        const retainedNode = retained === f.host.querySelector('.st-column-ruler[data-column="40"]');
        // The physical scrollbar is capped; rulers continue to use logical source columns.
        const doc = f.workspace.document(f.editor.view.documentId);
        f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: doc.buffer.length, insert: "x".repeat(500_000) }] });
        viewport.configure({ columnRulers: [450000] }); settle(); viewport.scrollTo({ left: 450000 * viewport.getSnapshot().columnWidth }); settle();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); settle();
        const s = viewport.getDiagnostics(), guide = f.host.querySelector<HTMLElement>(".st-column-ruler")!, rectangle = f.host.querySelector(".st-viewport-layer")!.getBoundingClientRect();
        const scaledError = Math.abs(guide.getBoundingClientRect().left - rectangle.left - (12 + 450000 * s.columnWidth - s.scrollLeft) * 1.25);
        const markedPoint = viewport.coordsAt(450000), selected = f.editor.view.getSnapshot().selectionSet, extent = [viewport.element.scrollWidth, viewport.element.scrollHeight];
        viewport.configure({ columnRulers: [] }); settle();
        return { rows, retainedNode, scaledError, scaled: s.horizontalExtent > s.physicalWidth, scaledUnits: s.textUnits, noGuides: !f.host.querySelector(".st-column-rulers"),
            samePoint: JSON.stringify(markedPoint) === JSON.stringify(viewport.coordsAt(450000)), sameSelections: selected === f.editor.view.getSnapshot().selectionSet,
            extent, emptyExtent: [viewport.element.scrollWidth, viewport.element.scrollHeight] };
    });
    await info.attach("changed-ruler-geometry", { body: JSON.stringify(changes), contentType: "application/json" });
    expect(changes.rows.every(row => row.error < 1.01 && row.inside && row.textUnits <= row.rows * 512)).toBe(true);
    expect(changes.rows[2]!.columnWidth).toBeGreaterThan(changes.rows[1]!.columnWidth);
    expect(changes).toMatchObject({ retainedNode: true, scaled: true, noGuides: true, samePoint: true, sameSelections: true });
    expect(changes.scaledError).toBeLessThan(.5); expect(changes.scaledUnits).toBeLessThan(1000); expect(changes.emptyExtent).toEqual(changes.extent);
    const end = await page.evaluate(() => { const f = window.presentationFixture, viewport = f.editor.viewport;
        viewport.configure({ columnRulers: [20] }); f.workspace.tabs.close(f.tab); viewport.flush(); const closed = !f.host.querySelector(".st-column-rulers");
        f.editor.dispose(); f.workspace.releaseResource(f.resource, true);
        return { closed, configured: viewport.configure({ columnRulers: [20] }), columns: viewport.settings().columnRulers, children: f.host.childNodes.length,
            views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions }; });
    expect(end).toEqual({ closed: true, configured: false, columns: [], children: 0, views: 0, subscriptions: 0 });
    await info.attach("ruler-geometry", { body: JSON.stringify({ initial, changes, end }), contentType: "application/json" });
});

test("current-line presentation follows the primary caret through input, folding and independent aligned review", async ({ page }, info) => {
    const initial = await page.evaluate(async () => {
        const path = "/presentation-fixture/", { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "current-line", variant: "text" }, "Current line", { value: "head\nbody\nmore\nend\n" });
        const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "current-line"), host = document.createElement("section"), style = document.createElement("style");
        host.style.cssText = "height:400px;width:800px;--st-current-line:#ffffff18";
        style.textContent = ".host-row { background: rgb(30, 45, 65) } .host-color { color: rgb(180, 60, 160) }"; document.body.append(style, host);

        const editor = mountTextEditor(host, workspace, tab, { ariaLabel: "Line source" }), viewport = editor.viewport;
        editor.decorations.addProvider({ name: "syntax", order: 0, lineClass: () => "host-row",
            provide: line => [{ from: line.from, to: line.to, className: "host-color" }] });
        window.presentationFixture = { workspace, editor, tab, resource: resource.id, host };
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); viewport.flush();
        const defaults = viewport.settings().highlightCurrentLine, point = viewport.coordsAt(1), row = host.querySelector('.st-viewport-row[data-line="0"]')!, child = row.firstChild;
        const extent = [viewport.element.scrollWidth, viewport.element.scrollHeight]; viewport.configure({ highlightCurrentLine: true }); viewport.flush();
        const enabled = viewport.settings().highlightCurrentLine, background = host.querySelector<HTMLElement>(".st-current-line-background")!;
        const number = host.querySelector(".st-line-numbers [data-current]")!, ordinary = host.querySelector(".st-line-numbers span:not([data-current])")!;
        viewport.configure({ highlightCurrentLine: true });
        return { defaults, enabled, number: number.textContent, distinctNumber: getComputedStyle(number).color !== getComputedStyle(ordinary).color
                && getComputedStyle(number).fontWeight !== getComputedStyle(ordinary).fontWeight,
            noOpPending: viewport.activity().pending, samePoint: JSON.stringify(point) === JSON.stringify(viewport.coordsAt(1)),
            sameChild: row.firstChild === child, className: row.className, background: getComputedStyle(row).backgroundColor, color: getComputedStyle(child as HTMLElement).color,
            width: background.getBoundingClientRect().width, viewportWidth: viewport.element.clientWidth - viewport.getSnapshot().gutterWidth, extent,
            nextExtent: [viewport.element.scrollWidth, viewport.element.scrollHeight] };
    });
    expect(initial).toMatchObject({ defaults: false, enabled: true, number: "1", distinctNumber: true, noOpPending: false, samePoint: true, sameChild: true,
        className: "st-viewport-row host-row st-current-line", background: "rgb(30, 45, 65)", color: "rgb(180, 60, 160)" });
    expect(initial.extent).toEqual(initial.nextExtent); expect(initial.width).toBe(initial.viewportWidth);
    const source = page.getByRole("textbox", { name: "Line source", exact: true }), current = page.locator(".st-viewport-layer .st-current-line");
    await source.press("Control+Home"); await source.press("ArrowDown"); await expect(current).toHaveAttribute("data-line", "1");
    await source.press("Enter"); await expect(current).toHaveAttribute("data-line", "2");
    await source.press("Control+z"); await expect(current).toHaveAttribute("data-line", "1");
    const projected = await page.evaluate(() => {
        const f = window.presentationFixture, viewport = f.editor.viewport, doc = f.workspace.document(f.editor.view.documentId);
        f.editor.view.setSelections(doc.revision, [{ anchor: 0, head: 2 }, { anchor: 10, head: 10 }], 1); viewport.flush();
        const primary = f.host.querySelector(".st-viewport-layer .st-current-line")?.getAttribute("data-line");
        const markedNumbers = () => [...f.host.querySelectorAll(".st-line-numbers [data-current]")].map(node => node.textContent);
        const primaryNumbers = markedNumbers();
        f.editor.view.setSelections(doc.revision, [{ anchor: 0, head: 2 }, { anchor: 10, head: 10 }], 0); viewport.flush();
        const rangeHidden = !f.host.querySelector(".st-current-line-background"), selected = f.host.querySelector<HTMLElement>(".st-viewport-selected")!;
        const selectedColor = getComputedStyle(selected).backgroundColor;
        const rangeNumbers = markedNumbers();
        f.editor.view.setSelection(doc.revision, { anchor: 6, head: 6 });
        f.editor.view.folding.setRanges(f.editor.view.folding.getSnapshot(), [{ id: "block", from: 0, to: doc.buffer.offsetAt(3), collapsed: true }]); viewport.flush();
        const header = f.host.querySelector(".st-viewport-layer .st-current-line")?.getAttribute("data-line"), head = f.editor.view.getSnapshot().selection.head;
        const rect = f.host.querySelector(".st-current-line-background")!.getBoundingClientRect(), row = f.host.querySelector('.st-viewport-row[data-line="0"]')!.getBoundingClientRect();
        return { primary, primaryNumbers, rangeHidden, rangeNumbers, selectedColor, header, headerNumbers: markedNumbers(), head, foldedTop: rect.top, rowTop: row.top };
    });
    expect(projected).toMatchObject({ primary: "2", primaryNumbers: ["3"], rangeHidden: true, rangeNumbers: [],
        selectedColor: "rgb(36, 73, 107)", header: "0", headerNumbers: ["1"], head: 6 });
    expect(projected.foldedTop).toBe(projected.rowTop);

    await page.evaluate(async () => {
        const f = window.presentationFixture, path = "/presentation-fixture/";
        const { TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        f.editor.dispose(); f.host.style.height = "500px";
        f.comparison = mountTextComparison(f.host, f.workspace, f.tab, { buffer: TextBuffer.from("extra\nHEAD\nbody\nmore\nend\n"), version: "one" }, { rowsAligned: true });
    });
    await page.waitForFunction(() => { const c = window.presentationFixture.comparison!;
        return c.controller.getSnapshot().status === "ready" && c.getDiagnostics().rowsAligned && !c.panes.working.viewport.activity().pending && !c.panes.reference.viewport.activity().pending; });
    const aligned = await page.evaluate(() => {
        const f = window.presentationFixture, c = f.comparison!, working = c.panes.working, reference = c.panes.reference;
        const current = (editor: TextEditor) => editor.element.querySelector(".st-viewport-layer .st-current-line");
        working.viewport.configure({ highlightCurrentLine: true }); working.viewport.flush();
        const workingClass = current(working)!.className, referenceDefault = reference.viewport.settings().highlightCurrentLine;
        reference.viewport.configure({ highlightCurrentLine: true }); reference.view.setSelection(f.workspace.document(reference.view.documentId).revision, { anchor: 7, head: 7 }); reference.viewport.flush();
        const referenceClass = current(reference)!.className;
        working.view.setSelection(f.workspace.document(working.view.documentId).revision, { anchor: 6, head: 6 }); working.viewport.flush();
        const row = current(working)!, backdrop = working.element.querySelector(".st-current-line-background")!, background = backdrop.getBoundingClientRect();
        const result = { workingClass, referenceDefault, referenceClass, referenceReadOnly: reference.getSnapshot().readOnlyReason === "read-only", padding: working.viewport.getDiagnostics().paddingRows,
            line: row.getAttribute("data-line"), rowGap: (working.viewport.rowBounds(1)!.top - working.viewport.rowBounds(0)!.top) / working.viewport.getSnapshot().lineHeight, topError: Math.abs(background.top - row.getBoundingClientRect().top),
            height: background.height, lineHeight: working.viewport.getSnapshot().lineHeight,
            edges: getComputedStyle(backdrop).boxShadow, fill: getComputedStyle(backdrop, "::before").backgroundColor };
        working.viewport.configure({ highlightCurrentLine: false }); working.viewport.flush();
        return { ...result, disabled: !current(working), referenceRetained: current(reference)?.getAttribute("data-line") };
    });
    expect(aligned.workingClass).toContain("st-comparison-line-working"); expect(aligned.workingClass).toContain("st-current-line");
    expect(aligned.referenceClass).toContain("st-comparison-line-baseline"); expect(aligned.referenceClass).toContain("st-current-line");
    expect(aligned).toMatchObject({ referenceDefault: false, referenceReadOnly: true, line: "1", disabled: true, referenceRetained: "1" });
    expect(aligned.padding).toBeGreaterThan(0); expect(aligned.rowGap).toBeGreaterThan(1); expect(aligned.topError).toBeLessThan(.1);
    expect(Math.abs(aligned.height - aligned.lineHeight)).toBeLessThan(.1);
    expect(aligned.edges).toContain("inset"); expect(aligned.fill).not.toBe("rgba(0, 0, 0, 0)");
    await info.attach("current-line-review", { body: await page.screenshot(), contentType: "image/png" });
    const end = await page.evaluate(() => { const f = window.presentationFixture, c = f.comparison!, reference = c.panes.reference.viewport;
        c.dispose(); f.workspace.tabs.close(f.tab); f.workspace.releaseResource(f.resource, true);
        return { configured: reference.configure({ highlightCurrentLine: true }), enabled: reference.settings().highlightCurrentLine, children: f.host.childNodes.length,
            views: f.workspace.diagnostics().views, subscriptions: f.workspace.diagnostics().subscriptions }; });
    expect(end).toEqual({ configured: false, enabled: false, children: 0, views: 0, subscriptions: 0 });
    await info.attach("current-line-geometry", { body: JSON.stringify({ initial, projected, aligned, end }), contentType: "application/json" });
});
