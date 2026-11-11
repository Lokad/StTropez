import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const source = (p: Page, name = "Primary source") => p.getByRole("textbox", { name, exact: true });
declare global { interface Window { heldDraftTransactions: readonly IDBTransaction[]; releaseDraftTransactions: () => void; draftPeerNotices: number; watchNextDraftNotice: () => void; nextDraftNotice: Promise<void> } }
/** Delay notification of a completed native transaction; its storage locks have already been released. */
async function holdDraftTransaction(p: Page, mode: IDBTransactionMode = "readonly"): Promise<void> { await p.evaluate(mode => {
    const original = IDBDatabase.prototype.transaction, held: IDBTransaction[] = []; window.heldDraftTransactions = held;
    IDBDatabase.prototype.transaction = function (...args) { const tx = original.apply(this, args);
        if (this.name === "sttropez-example-drafts-v1" && args[1] === mode) tx.addEventListener("complete", event => { event.stopImmediatePropagation(); held.push(tx); }, { capture: true, once: true });
        return tx;
    };
    window.releaseDraftTransactions = () => { IDBDatabase.prototype.transaction = original; for (const tx of held.splice(0)) tx.dispatchEvent(new Event("complete")); };
}, mode); }
function trackDraftNotices(): void {
    const Native = window.BroadcastChannel, name = "sttropez-example-drafts-v1"; window.draftPeerNotices = 0;
    window.BroadcastChannel = class extends Native { constructor(channel: string) { super(channel); if (channel === name) this.addEventListener("message", () => { window.draftPeerNotices++; }); } };
    window.watchNextDraftNotice = () => { const channel = new Native(name); window.nextDraftNotice = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { channel.close(); reject(new Error("Peer draft notice was not delivered.")); }, 5000);
        channel.onmessage = () => { clearTimeout(timer); channel.close(); resolve(); };
    }); void window.nextDraftNotice.catch(() => {}); };
}
async function keep(p: Page): Promise<void> { await button(p, "Keep recovery draft").click(); if ((await snapshot(p)).draft!.confirmation === "keep") await button(p, "Confirm draft action").click(); await ready(p); }
const notices = (p: Page) => p.evaluate(() => window.draftPeerNotices);
async function peerNotice(p: Page, after: number): Promise<void> { await p.waitForFunction(after => window.draftPeerNotices > after && !window.hostFixture.snapshot().draft!.busy, after); await ready(p); }
async function preserved(p: Page, before: Awaited<ReturnType<typeof snapshot>>, text: string): Promise<void> { const after = await snapshot(p); expect(after.source).toEqual(before.source); expect(after.history).toEqual(before.history); expect(selections(after)).toEqual(selections(before)); await exact(p, text); }
async function stored(p: Page, text: string | null): Promise<string | null> { const row = await p.evaluate(text => new Promise<{ matches: boolean; token: string | null }>((resolve, reject) => {
    const open = indexedDB.open("sttropez-example-drafts-v1", 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction("drafts", "readonly"), get = tx.objectStore("drafts").get("working-inputs");
        tx.oncomplete = () => { const row = get.result; db.close(); resolve({ matches: text === null ? row === undefined : row?.value?.source?.text === text, token: row?.token ?? null }); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
}), text); expect(row.matches).toBe(true); return row.token; }
const selections = (s: Awaited<ReturnType<typeof snapshot>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })), working: s.bindings.comparison?.selectionSet, reference: s.bindings.comparison?.referenceViewport?.selectionSet });
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} loaded-source checkpoint survives close and real reload independently`, async ({ page: p }, info) => {
    test.setTimeout(120000); const errors: string[] = []; p.on("pageerror", e => errors.push(e.message));
    await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p);
    await button(p, "Begin delayed load").click(); await button(p, "Finish delayed load").click(); await ready(p);
    const loaded = (await snapshot(p)).bindings.views.find(v => v.id === "primary")!;
    const value = "loaded café😀 é\r\n" + "row Δ😀\r\n".repeat(large ? 100000 : 8) + "tail";
    await p.evaluate(({ id, value }) => { const f = window.hostFixture, s = f.navigationDocument(id); f.editLinkTarget(id, s.revision, [{ from: 0, to: s.length, insert: value }]); }, { id: loaded.documentId, value });
    await source(p).press("Control+End"); await source(p).pressSequentially("K"); await ready(p);
    let doc = await p.evaluate(id => window.hostFixture.navigationDocument(id), loaded.documentId); expect(doc.exports).toBe(0);
    await p.evaluate(revision => window.hostFixture.selectSourceSet("primary", revision, [{ anchor: 4, head: 1 }, { anchor: 12, head: 8 }], 1), doc.revision); await ready(p);
    const beforeClose = (await snapshot(p)).bindings.views.find(v => v.id === "primary")!;
    await button(p, "Prompt close").click(); await button(p, "Confirm close").click(); await button(p, "Reopen loaded source").click(); await ready(p);
    expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(beforeClose.selectionSet);
    await keep(p); expect((await snapshot(p)).draft).toMatchObject({ hasLoaded: true, unprotected: false }); expect(await warning(p)).toBe(false);
    await source(p).press("Control+End"); await source(p).pressSequentially("L"); await ready(p); expect(await warning(p)).toBe(true);
    await source(p).press("Control+z"); await ready(p); expect(await warning(p)).toBe(false);
    await p.reload(); await ready(p); await exact(p, "start"); const original = await snapshot(p), originalDocument = original.bindings.views.find(v => v.id === "primary")!.documentId;
    await button(p, "Save source").click(); await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).pendingRuns.length).toBe(1);
    const pending = await snapshot(p); await restore(p, "Restore loaded-source draft"); await exact(p, "start");
    expect((await snapshot(p)).bindings.views.find(v => v.id === "primary")!.documentId).toBe(originalDocument);
    await button(p, "Reopen loaded source").click(); await ready(p); const restored = (await snapshot(p)).bindings.views.find(v => v.id === "primary")!;
    expect(restored.documentId).not.toBe(originalDocument); expect((await snapshot(p)).pendingSaves).toEqual(pending.pendingSaves); expect((await snapshot(p)).pendingRuns).toEqual(pending.pendingRuns);
    doc = await p.evaluate(id => window.hostFixture.navigationDocument(id), restored.documentId); expect(doc.length).toBe(value.length + 1); expect(doc.text).toBe((value + "K").slice(0, 4096)); expect(doc.exports).toBe(0);
    await source(p).press("Control+z"); await ready(p); expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, restored.documentId)).toBe("loaded resource");
    await source(p).press("Control+Shift+z"); await ready(p); expect((await snapshot(p)).history).toEqual(original.history);
    await button(p, "Finish save").click(); await button(p, "Finish run").click(); await expect.poll(async () => (await snapshot(p)).pendingCommands).toBe(0);
    await keep(p);
    const storedLoaded = await p.evaluate(() => new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("sttropez-example-drafts-v1", 1); open.onerror = () => reject(open.error); open.onsuccess = () => {
            const db = open.result, tx = db.transaction("drafts", "readonly"), get = tx.objectStore("drafts").get("working-inputs");
            tx.oncomplete = () => { db.close(); resolve(get.result.value.loaded.text); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
    }));
    expect(storedLoaded).toBe(value + "K"); expect(await warning(p)).toBe(false); await exact(p, "start");
    expect(restored.metrics!.viewport.rows).toBeLessThan(100); await p.screenshot({ path: info.outputPath("loaded-source-restored.png") });
    await dispose(p); expect(errors).toEqual([]);
});
async function ready(p: Page): Promise<void> { await p.waitForFunction(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison; return !s.draft?.busy && s.bindings.views.every(v => !v.metrics || !v.metrics.pendingInput && !v.metrics.pendingCommand && !v.metrics.pendingCaret && !v.metrics.viewport.pending)
    && (!c || c.status === "ready" && !c.input.pendingInput && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending); }); }
async function exact(p: Page, value: string): Promise<void> { expect(await p.evaluate(value => { const f = window.hostFixture; if (f.snapshot().source.length !== value.length) return false; for (let from = 0; from < value.length; from += 32768) if (f.range(from, Math.min(value.length, from + 32768)) !== value.slice(from, from + 32768)) return false; return true; }, value)).toBe(true); }
async function warning(p: Page): Promise<boolean> { return p.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }); }
async function restore(p: Page, name: string): Promise<void> { await button(p, name).click(); await expect(button(p, "Confirm draft action")).toBeEnabled(); await button(p, "Confirm draft action").click(); await ready(p); }
async function dispose(p: Page): Promise<void> { await p.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(p); expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.draft?.disposed).toBe(true); }
async function closeWithDecision(p: Page, accept: boolean): Promise<void> {
    // close(runBeforeUnload) returns before closure; dismissal must leave the same page alive.
    const handled = p.waitForEvent("dialog").then(async dialog => { expect(dialog.type()).toBe("beforeunload"); await (accept ? dialog.accept() : dialog.dismiss()); });
    const closed = accept ? p.waitForEvent("close") : undefined;
    await Promise.all([p.close({ runBeforeUnload: true }), handled]);
    if (closed) await closed;
}
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} browser close decisions retain live work and offer only explicit checkpoint recovery`, async ({ page: p }) => {
    test.setTimeout(120000); const errors: string[] = []; p.on("pageerror", e => errors.push(e.message));
    await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p);
    const raw = "close café😀 é\r\n" + "const stableValue = 123;\r\n".repeat(large ? 100000 : 10) + "tail";
    await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, raw);
    // Trusted browser input supplies user activation; no global keyboard or OS clipboard is used.
    await source(p).press("Control+End"); await source(p).pressSequentially("K");
    await p.getByRole("textbox", { name: "Configuration path", exact: true }).fill("checkpoint.csv"); await ready(p); await keep(p);
    expect((await snapshot(p)).draft!.unprotected).toBe(false);
    await button(p, "Open source review").click(); await ready(p);
    await p.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 4, head: 1 }, { anchor: 12, head: 8 }], 1); }); await ready(p);
    await button(p, "Save source").click(); await expect.poll(async () => (await snapshot(p)).pendingSaves.length).toBe(1);
    const pending = await snapshot(p); expect(pending.draft!.unprotected).toBe(false);
    // Checkpoint coverage does not cover an unsettled service request.
    await closeWithDecision(p, false); expect(p.isClosed()).toBe(false); await ready(p); await preserved(p, pending, raw + "K");
    let after = await snapshot(p); expect(after.pendingSaves).toEqual(pending.pendingSaves); expect(after.diagnostics).toEqual(pending.diagnostics);
    expect(after.hostSubscriptions).toBe(pending.hostSubscriptions); expect(after.bindings.comparison!.baseline).toEqual(pending.bindings.comparison!.baseline); expect(after.draft!.disposed).toBe(false);
    await button(p, "Finish save").click(); await expect.poll(async () => (await snapshot(p)).pendingCommands).toBe(0);
    await source(p).press("Control+End"); await source(p).pressSequentially("L"); await ready(p);
    const later = await snapshot(p); expect(later.draft!.unprotected).toBe(true); expect(later.source.exports).toBe(0);
    await closeWithDecision(p, false); await ready(p); await preserved(p, later, raw + "KL");
    // A cancelled close did not dispose handlers or history in either view.
    await source(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw + "K");
    await source(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, raw + "KL");
    const context = p.context(), url = p.url(); await closeWithDecision(p, true); expect(p.isClosed()).toBe(true);
    const reopened = await context.newPage(); reopened.on("pageerror", e => errors.push(e.message)); await reopened.goto(url); await ready(reopened);
    await exact(reopened, "start"); await expect(reopened.getByRole("textbox", { name: "Configuration path", exact: true })).toHaveValue("source.csv");
    expect((await snapshot(reopened)).draft).toMatchObject({ present: true, valid: true, sourceUnits: raw.length + 1 });
    await stored(reopened, raw + "K"); await restore(reopened, "Restore source draft"); await exact(reopened, raw + "K");
    await expect(reopened.getByRole("textbox", { name: "Configuration path", exact: true })).toHaveValue("source.csv");
    const restored = await snapshot(reopened); await restore(reopened, "Restore configuration draft");
    await expect(reopened.getByRole("textbox", { name: "Configuration path", exact: true })).toHaveValue("checkpoint.csv");
    after = await snapshot(reopened); expect(after.source).toEqual(restored.source); expect(after.history).toEqual(restored.history);
    expect(after.source.exports).toBe(0); expect(after.pendingSaves).toEqual([]); expect(after.pendingRuns).toEqual([]);
    // Covered, settled inputs can really close without showing a confirmation.
    const dialogs: string[] = []; reopened.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.accept(); });
    const closed = reopened.waitForEvent("close"); await reopened.close({ runBeforeUnload: true }); await closed;
    expect(dialogs).toEqual([]); expect(errors).toEqual([]);
});
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} durable drafts restore independent inputs after true reload and preserve history Save/Run`, async ({ page: p }) => {
    test.setTimeout(120000); p.on("pageerror", e => { throw e; }); await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p);
    const raw = "café😀 é;\r\n" + "const stableValue = 123;\r\n".repeat(large ? 100000 : 10) + "tail";
    await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, raw);
    await source(p).press("Control+End"); await source(p).pressSequentially("K"); await p.getByRole("textbox", { name: "Configuration path", exact: true }).fill("recovered.csv"); await ready(p); expect((await snapshot(p)).source.exports).toBe(0);
    await button(p, "Keep recovery draft").click(); await ready(p); expect((await snapshot(p)).draft).toMatchObject({ present: true, valid: true, unprotected: false, sourceUnits: raw.length + 1 });
    await source(p).press("Control+End"); await source(p).pressSequentially("L"); await ready(p); expect((await snapshot(p)).source.exports).toBe(0); expect((await snapshot(p)).draft!.sourceUnits).toBe(raw.length + 1); expect(await warning(p)).toBe(true);
    await source(p).press("Control+z"); await ready(p); await exact(p, raw + "K"); expect(await warning(p)).toBe(false);
    await p.evaluate(() => { document.documentElement.dataset.draftSession = "old"; }); await p.reload(); await ready(p); expect(await p.evaluate(() => document.documentElement.dataset.draftSession)).toBeUndefined(); await exact(p, "start"); await expect(p.getByRole("textbox", { name: "Configuration path", exact: true })).toHaveValue("source.csv");
    await restore(p, "Restore source draft"); await exact(p, raw + "K"); expect((await snapshot(p)).history.undoDepth).toBe(1); const revision = (await snapshot(p)).source.revision;
    await restore(p, "Restore configuration draft"); await expect(p.getByRole("textbox", { name: "Configuration path", exact: true })).toHaveValue("recovered.csv"); expect((await snapshot(p)).source.revision).toBe(revision); expect(await warning(p)).toBe(false);
    if (!large) {
        await p.goto(`/hosts/${host === "plain" ? "react" : "plain"}/?editor=native`); await ready(p); await exact(p, "start"); await restore(p, "Restore source draft"); await restore(p, "Restore configuration draft"); await exact(p, raw + "K"); expect((await snapshot(p)).history.undoDepth).toBe(1);
        await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p); await restore(p, "Restore source draft"); await restore(p, "Restore configuration draft"); await exact(p, raw + "K");
    }
    await source(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, "start"); await source(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, raw + "K");
    // Establish a newer authoritative saved baseline before restoring the older stored copy.
    const loaded = "loaded café😀\r\nnew saved baseline"; await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, loaded); await ready(p); await source(p).press("Control+s"); await button(p, "Finish save").click();
    await expect.poll(async () => (await snapshot(p)).source.serverVersion).toBe("v1"); await ready(p); const beforeRestore = await snapshot(p); expect(beforeRestore.source.dirty).toBe(false);
    await restore(p, "Restore source draft"); await exact(p, raw + "K"); expect((await snapshot(p)).source).toMatchObject({ serverVersion: "v1", dirty: true }); expect((await snapshot(p)).history.undoDepth).toBe(beforeRestore.history.undoDepth + 1);
    await source(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, loaded); expect((await snapshot(p)).source.dirty).toBe(false); await source(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, raw + "K");
    await button(p, "Open source review").click(); await ready(p); const ref = source(p, "Comparison baseline source"), baseline = (await snapshot(p)).bindings.comparison!.baseline!.version; await ref.press("Control+s"); expect((await snapshot(p)).pendingSaves).toHaveLength(1); expect((await snapshot(p)).pendingSaves[0]!.expectedServerVersion).toBe("v1");
    await source(p).press("Control+End"); await source(p).pressSequentially("L"); await button(p, "Finish save").click(); await ready(p); await expect.poll(async () => (await snapshot(p)).pendingCommands).toBe(0); await exact(p, raw + "KL"); expect((await snapshot(p)).source.dirty).toBe(true);
    await source(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw + "K"); expect((await snapshot(p)).source.dirty).toBe(false); await source(p, "Secondary source").press("Control+Shift+z"); await ready(p);
    expect((await snapshot(p)).bindings.comparison!.baseline!.version).toBe(baseline); await p.evaluate(() => window.hostFixture.externalWrite("new remote source\r\n"));
    await ref.press("Control+s"); expect((await snapshot(p)).pendingSaves[0]!.expectedServerVersion).toBe("v2"); await button(p, "Finish save").click(); await expect.poll(async () => (await snapshot(p)).source.saveStatus).toBe("conflict"); await exact(p, raw + "KL");
    await button(p, "Review remote source").click(); await p.evaluate(() => window.hostFixture.finishConflictReview()); await ready(p); expect(await p.evaluate(() => window.hostFixture.referenceRange(0, 19))).toBe("new remote source\r\n"); const remote = (await snapshot(p)).bindings.comparison!.baseline!.version;
    const working = source(p, "Comparison working source"); await working.press("Control+End"); await working.pressSequentially("M"); await button(p, "Save reviewed source").click(); expect((await snapshot(p)).pendingSaves[0]!.expectedServerVersion).toBe("v3");
    await working.pressSequentially("N"); await button(p, "Finish save").click(); await expect.poll(async () => (await snapshot(p)).source.serverVersion).toBe("v4"); await ready(p); await exact(p, raw + "KLMN"); expect((await snapshot(p)).source.dirty).toBe(true);
    await source(p, "Secondary source").press("Control+z"); await ready(p); await exact(p, raw + "KLM"); expect((await snapshot(p)).source.dirty).toBe(false); await source(p, "Secondary source").press("Control+Shift+z"); await ready(p); await exact(p, raw + "KLMN");
    await ref.focus(); await button(p, "Run captured inputs").click(); const s = await snapshot(p); expect(s.activity.lastRun!.sourceRevision).toBe(s.source.revision); expect(s.bindings.comparison!.baseline!.version).toBe(remote); expect(await p.evaluate(() => window.hostFixture.runCapture(0)!.configuration.path)).toBe("recovered.csv"); expect(await p.evaluate(() => window.hostFixture.runCapture(0)!.source.slice(-4))).toBe("KLMN"); await button(p, "Finish run").click(); await ready(p);
    // A genuine stored read is pending while authority is revoked and restored by takeover.
    await holdDraftTransaction(p); await button(p, "Restore source draft").click(); await button(p, "Confirm draft action").click(); await p.waitForFunction(() => window.heldDraftTransactions.length === 1); const intent = await snapshot(p);
    await button(p, "Associate agent").click(); await button(p, "Request proposal").click(); await button(p, "Interrupt agent").click(); await p.evaluate(() => window.releaseDraftTransactions()); await ready(p);
    await expect(p.getByLabel("Draft recovery status", { exact: true })).toContainText("became stale"); await exact(p, raw + "KLMN"); expect((await snapshot(p)).history).toEqual(intent.history); expect(selections(await snapshot(p))).toEqual(selections(intent));
    await button(p, "Deliver proposal").click(); await expect.poll(async () => (await snapshot(p)).pendingCommands).toBe(0); await ready(p); await exact(p, raw + "KLMN"); expect((await snapshot(p)).review.proposal).toBeNull(); expect((await snapshot(p)).history).toEqual(intent.history); expect(selections(await snapshot(p))).toEqual(selections(intent)); await dispose(p);
});
for (const host of ["plain", "react"]) test(`${host} draft confirmation, authority, storage errors and discard never overwrite later work`, async ({ page: p }) => {
    test.setTimeout(120000); p.on("pageerror", e => { throw e; });
    await p.addInitScript(() => { const open = IDBFactory.prototype.open; let reject = true; IDBFactory.prototype.open = function (...args) { if (args[0] === "sttropez-example-drafts-v1" && reject) { reject = false; throw new DOMException("Injected temporary open rejection", "UnknownError"); } return open.apply(this, args); }; });
    await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p); await expect(p.getByLabel("Draft recovery status", { exact: true })).toContainText("unavailable");
    await source(p).press("Control+a"); await source(p).pressSequentially("stored draft"); await button(p, "Retry draft storage").click(); await ready(p); await button(p, "Keep recovery draft").click(); await ready(p); expect((await snapshot(p)).draft!.valid).toBe(true);
    await button(p, "Restore source draft").click(); await source(p).press("Control+End"); await source(p).pressSequentially(" later"); await button(p, "Confirm draft action").click(); await ready(p); await exact(p, "stored draft later");
    await button(p, "Restore source draft").click(); await p.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); }); await button(p, "Confirm draft action").click(); await ready(p); await exact(p, "stored draft later");
    const configuration = p.getByRole("textbox", { name: "Configuration path", exact: true }); await configuration.fill("local.csv"); await button(p, "Restore configuration draft").click();
    await configuration.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await button(p, "Confirm draft action").click(); await ready(p);
    await expect(configuration).toHaveValue("local.csv"); await configuration.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await p.evaluate(() => { const original = IDBObjectStore.prototype.put; Object.assign(window, { originalDraftPut: original }); IDBObjectStore.prototype.put = function (...args) { if (this.transaction.db.name === "sttropez-example-drafts-v1") throw new DOMException("Injected quota rejection", "QuotaExceededError"); return original.apply(this, args); }; });
    await button(p, "Keep recovery draft").click(); await button(p, "Confirm draft action").click(); await ready(p); await expect(p.getByLabel("Draft recovery status", { exact: true })).toContainText("failed"); await exact(p, "stored draft later"); expect(await warning(p)).toBe(true);
    await p.evaluate(() => { IDBObjectStore.prototype.put = (window as unknown as { originalDraftPut: typeof IDBObjectStore.prototype.put }).originalDraftPut; }); await button(p, "Retry draft storage").click(); await ready(p); expect((await snapshot(p)).draft!.sourceUnits).toBe("stored draft".length);
    await button(p, "Discard stored draft").click(); await source(p).press("Control+End"); await source(p).pressSequentially(" owned"); await button(p, "Confirm draft action").click(); await ready(p); expect((await snapshot(p)).draft!.present).toBe(false); await exact(p, "stored draft later owned"); expect(await warning(p)).toBe(true); await dispose(p);
});
for (const host of ["plain", "react"]) test(`${host === "plain" ? "" : "react "}native draft transactions reject stale overwrite and discard tokens`, async ({ page: p }) => {
    test.setTimeout(120000); await p.context().addInitScript(trackDraftNotices);
    await p.goto(`/hosts/${host}/?editor=candidate`); await ready(p); await source(p).press("Control+a"); await source(p).pressSequentially("stored version"); await button(p, "Keep recovery draft").click(); await ready(p);
    expect(await warning(p)).toBe(false);
    const replaceStored = async (token: string) => p.evaluate(token => new Promise<void>((resolve, reject) => { const open = indexedDB.open("sttropez-example-drafts-v1", 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"), get = store.get("working-inputs"); get.onsuccess = () => { const row = get.result; row.token = token; row.value.id = token; row.value.source.text = "peer retained text"; store.put(row, "working-inputs"); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; }; }), token);
    await button(p, "Discard stored draft").click(); await replaceStored("external-newer"); await button(p, "Confirm draft action").click(); await ready(p); expect((await snapshot(p)).draft!.present).toBe(true); await exact(p, "stored version"); expect(await warning(p)).toBe(true); await expect(p.getByLabel("Draft recovery status", { exact: true })).toContainText("recheck storage");
    await button(p, "Retry draft storage").click(); await ready(p); await source(p).press("Control+End"); await source(p).pressSequentially(" local"); await button(p, "Keep recovery draft").click(); await replaceStored("external-latest"); await button(p, "Confirm draft action").click(); await ready(p); await exact(p, "stored version local");
    expect(await stored(p, "peer retained text")).toBe("external-latest");
    // Real same-origin pages share the store, while each owns its working document and view state.
    const peer = await p.context().newPage(), owned = "stored version local";
    let peerText = "peer café😀\r\n" + "const stableValue = 123;\r\n".repeat(100000) + "tail";
    await peer.goto(new URL(`/hosts/${host === "plain" ? "react" : "plain"}/?editor=candidate`, p.url()).href); await ready(peer);
    await peer.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, peerText); await ready(peer); await source(peer).focus(); const peerBefore = await snapshot(peer);
    await button(p, "Retry draft storage").click(); await ready(p); let seen = await notices(peer); await keep(p); await peerNotice(peer, seen); await preserved(peer, peerBefore, peerText); expect(await source(peer).evaluate(n => document.activeElement === n)).toBe(true);
    await source(p).focus(); await ready(p); let before = await snapshot(p); seen = await notices(p); await keep(peer); await peerNotice(p, seen); await preserved(p, before, owned); expect((await snapshot(p)).draft!.unprotected).toBe(true); expect(await warning(p)).toBe(true); expect(await warning(peer)).toBe(false); expect(await source(p).evaluate(n => document.activeElement === n)).toBe(true);
    // The persistent host service also observes the peer while its views are dormant.
    await p.evaluate(() => window.hostFixture.unmount()); const dormant = await snapshot(p); expect(dormant.diagnostics.subscriptions).toBe(4); expect(dormant.hostSubscriptions).toBe(2);
    await source(peer).press("Control+End"); await source(peer).pressSequentially("B"); peerText += "B"; seen = await notices(p); await keep(peer); await peerNotice(p, seen); await preserved(p, dormant, owned);
    await p.evaluate(() => window.hostFixture.mount()); await ready(p); await exact(p, owned); expect(selections(await snapshot(p))).toEqual(selections(before));
    await button(p, "Open source review").click(); await ready(p); const baseline = (await snapshot(p)).bindings.comparison!.baseline!.version;
    // A peer write cancels a restore already waiting for its real read completion.
    await holdDraftTransaction(p); await button(p, "Restore source draft").click(); await button(p, "Confirm draft action").click(); await p.waitForFunction(() => window.heldDraftTransactions.length === 1); await source(p).focus(); before = await snapshot(p);
    await source(peer).press("Control+End"); await source(peer).pressSequentially("C"); peerText += "C"; await keep(peer); await p.waitForFunction(() => window.heldDraftTransactions.length === 2); await p.evaluate(() => window.releaseDraftTransactions()); await ready(p); await preserved(p, before, owned); expect((await snapshot(p)).draft).toMatchObject({ sourceUnits: peerText.length, present: true, unprotected: true }); expect(await source(p).evaluate(n => document.activeElement === n)).toBe(true); await stored(peer, peerText);
    // Hold an accepted write's completion after commit, then let the peer retain a newer copy.
    await holdDraftTransaction(p, "readwrite"); await button(p, "Keep recovery draft").click(); await button(p, "Confirm draft action").click(); await p.waitForFunction(() => window.heldDraftTransactions.length === 1); before = await snapshot(p);
    await button(peer, "Retry draft storage").click(); await ready(peer); await source(peer).press("Control+End"); await source(peer).pressSequentially("D"); peerText += "D"; seen = await notices(p); await keep(peer); await peerNotice(p, seen); const retainedWrite = await stored(peer, peerText); let peerSeen = await notices(peer); await p.evaluate(() => window.releaseDraftTransactions()); await peerNotice(peer, peerSeen); await ready(p); await preserved(p, before, owned); expect((await snapshot(p)).draft).toMatchObject({ sourceUnits: peerText.length, present: true, unprotected: true }); expect(await stored(peer, peerText)).toBe(retainedWrite);
    // A late discard completion must not hide a newer copy created after its deletion committed.
    await holdDraftTransaction(p, "readwrite"); await button(p, "Discard stored draft").click(); await button(p, "Confirm draft action").click(); await p.waitForFunction(() => window.heldDraftTransactions.length === 1); before = await snapshot(p);
    await button(peer, "Retry draft storage").click(); await ready(peer); expect((await snapshot(peer)).draft!.present).toBe(false); await source(peer).press("Control+End"); await source(peer).pressSequentially("E"); peerText += "E"; seen = await notices(p); await keep(peer); await peerNotice(p, seen); const retainedDiscard = await stored(peer, peerText); peerSeen = await notices(peer); await p.evaluate(() => window.releaseDraftTransactions()); await peerNotice(peer, peerSeen); await ready(p); await preserved(p, before, owned); expect((await snapshot(p)).draft).toMatchObject({ sourceUnits: peerText.length, present: true, valid: true, unprotected: true }); expect(await stored(peer, peerText)).toBe(retainedDiscard);
    // A peer deletion also expires a held restore instead of resurrecting the removed record.
    await holdDraftTransaction(p); await button(p, "Restore source draft").click(); await button(p, "Confirm draft action").click(); await p.waitForFunction(() => window.heldDraftTransactions.length === 1); before = await snapshot(p);
    await button(peer, "Discard stored draft").click(); await button(peer, "Confirm draft action").click(); await ready(peer); await p.waitForFunction(() => window.heldDraftTransactions.length === 2); await p.evaluate(() => window.releaseDraftTransactions()); await ready(p); await preserved(p, before, owned); expect((await snapshot(p)).draft).toMatchObject({ present: false, valid: false, unprotected: true }); expect((await snapshot(p)).bindings.comparison!.baseline!.version).toBe(baseline); expect(await p.evaluate(() => window.hostFixture.referenceRange(0, 5))).toBe("start"); expect(await stored(peer, null)).toBeNull(); await expect.poll(async () => (await snapshot(p)).draft!.jobs).toBe(0);
    await dispose(p); const stopped = await snapshot(p), stoppedNotices = await notices(p); await p.evaluate(() => window.watchNextDraftNotice()); await keep(peer); await p.evaluate(() => window.nextDraftNotice); expect(await notices(p)).toBe(stoppedNotices); expect(await snapshot(p)).toEqual(stopped); await exact(peer, peerText); await dispose(peer); await peer.close();
});
