import { test, expect } from "./fixtures.ts";
import { viewportModules } from "../helpers/fixture-modules.ts";

test("viewport input ownership and render delivery survive removal, reentrancy and disposal", async ({ page }) => {
    await viewportModules(page, "/viewport-input/");
    await page.goto("/viewport/");
    const result = await page.evaluate(async () => {
        const path = "/viewport-input/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextViewport } = await import(path + "viewport.js") as typeof import("../../src/browser/viewport.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "interaction", variant: "text" }, "Input", { value: "a\nb\nc\nd\n" });
        const host = document.createElement("section");
        host.style.cssText = "height:220px;width:800px;position:fixed;top:0;left:0"; document.body.append(host);
        const viewport = mountTextViewport(host, workspace, source.id), root = viewport.element, input = document.createElement("textarea"); root.append(input);
        const order: string[] = []; let stopLater = () => {}, focus = 0, errors = 0, afterError = 0;
        const stopFirst = viewport.onRender(() => {
            order.push("first"); stopFirst(); stopRemoved(); stopLater = viewport.onRender(() => order.push("later"));
            workspace.edit({ documentId: source.id, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "x" }], origin: "host" });
        });
        const stopRemoved = viewport.onRender(() => order.push("removed")), stopLast = viewport.onRender(() => order.push("last"));
        const error = (event: ErrorEvent) => { if (event.error?.message === "viewport observer test") { errors++; event.preventDefault(); } };
        window.addEventListener("error", error);
        try {
            viewport.flush(); const firstOrder = [...order]; viewport.flush(); const secondOrder = [...order]; stopLast(); stopLater();
            const stopError = viewport.onRender(() => { stopError(); throw new Error("viewport observer test"); });
            const stopAfter = viewport.onRender(() => afterError++); viewport.invalidate(); viewport.flush(); stopAfter();
            const binding = viewport.bindInput(() => { focus++; input.focus({ preventScroll: true }); });
            let duplicate = false;
            try { viewport.bindInput(() => {}); } catch { duplicate = true; }
            const buffer = workspace.document(source.id).buffer, folding = viewport.view.folding;
            const ranges = [{ id: "first", from: 0, to: buffer.offsetAt(2) }, { id: "second", from: buffer.offsetAt(2), to: buffer.offsetAt(4) }];
            folding.setRanges(folding.getSnapshot(), ranges.slice(0, 1)); viewport.flush();
            binding.setComposing(true); root.classList.remove("st-composing");
            const button = root.querySelector<HTMLButtonElement>(".st-fold-button")!; button.disabled = false;
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            const guarded = !folding.getSnapshot().regions[0]!.collapsed;
            binding.setComposing(false);
            const existingEscaped = button.tabIndex === -1;
            folding.setRanges(folding.getSnapshot(), ranges); viewport.flush();
            const newEscaped = [...root.querySelectorAll<HTMLButtonElement>(".st-fold-button")].every(button => button.tabIndex === -1);
            root.setAttribute("data-st-tab-escape", ""); viewport.invalidate(); viewport.flush();
            const markersIgnored = [...root.querySelectorAll<HTMLButtonElement>(".st-fold-button")].every(button => button.tabIndex === -1);
            button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            const escapedFocus = document.activeElement === input && focus === 1;
            button.focus(); folding.setRanges(folding.getSnapshot(), []); viewport.flush();
            const removedFocus = document.activeElement === input && focus === 2;
            binding.dispose(); const detached = root.tabIndex === 0 && !root.querySelector(".st-viewport-layer")!.hasAttribute("aria-hidden");
            const replacement = viewport.bindInput(() => viewport.dispose()); replacement.setComposing(true); binding.dispose();
            const expired = !binding.setComposing(false) && root.classList.contains("st-composing"); replacement.setComposing(false);
            folding.setRanges(folding.getSnapshot(), ranges.slice(0, 1)); viewport.flush();
            root.querySelector<HTMLButtonElement>(".st-fold-button")!.focus();
            let afterDestroy = 0; viewport.onRender(() => afterDestroy++);
            folding.setRanges(folding.getSnapshot(), []); viewport.flush();
            const destroyed = viewport.getDiagnostics(); const inactive = !replacement.setComposing(true); replacement.dispose();
            viewport.onRender(() => afterDestroy++)(); viewport.flush();
            return { firstOrder, secondOrder, revision: workspace.document(source.id).revision, errors, afterError, duplicate,
                guarded, existingEscaped, newEscaped, markersIgnored, escapedFocus, removedFocus, detached, expired, inactive, afterDestroy,
                destroyed: { disposed: destroyed.disposed, revision: destroyed.revision, rows: destroyed.rows, pending: destroyed.pending } };
        } finally { window.removeEventListener("error", error); viewport.dispose(); workspace.releaseResource(source.id, true); host.remove(); }
    });
    expect(result).toEqual({ firstOrder: ["first", "last"], secondOrder: ["first", "last", "last", "later"], revision: 1,
        errors: 1, afterError: 1, duplicate: true, guarded: true, existingEscaped: true, newEscaped: true, markersIgnored: true,
        escapedFocus: true, removedFocus: true, detached: true, expired: true, inactive: true, afterDestroy: 0,
        destroyed: { disposed: true, revision: null, rows: 0, pending: false } });
});
