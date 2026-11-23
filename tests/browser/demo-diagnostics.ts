import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type DiagnosticProbe = { hold: boolean; pending: (() => void)[]; requests: { uri: string; kind: string }[]; release(): void };

/** Observe the actual provider boundary in both static and development hosts. */
export async function runDemoDiagnosticRetention(page: Page, url = "/") {
    await page.addInitScript(() => {
        const probe: DiagnosticProbe = { hold: false, pending: [], requests: [], release() {
            this.hold = false; this.pending.splice(0).forEach(deliver => deliver());
        } };
        Object.assign(window, { demoDiagnosticProbe: probe });
        const outgoing = (data: unknown, ids: Set<number>) => {
            if (typeof data !== "string") return;
            const message = JSON.parse(data);
            if (message.method === "sttropez/diagnostics") { ids.add(message.id); probe.requests.push(message.params); }
        };
        const observe = (target: EventTarget, ids: Set<number>) => target.addEventListener("message", event => {
            const data = (event as MessageEvent).data; if (typeof data !== "string") return;
            const message = JSON.parse(data); if (!ids.delete(message.id) || !probe.hold) return;
            event.stopImmediatePropagation(); probe.pending.push(() => target.dispatchEvent(new MessageEvent("message", { data })));
        }, { capture: true });
        const NativeWorker = Worker, NativeSocket = WebSocket;
        window.Worker = class extends NativeWorker {
            private readonly ids = new Set<number>();
            constructor(url: string | URL, options?: WorkerOptions) { super(url, options); if (String(url).endsWith("demo-language-worker.js")) observe(this, this.ids); }
            override postMessage(message: unknown, options: StructuredSerializeOptions | Transferable[] = []) {
                outgoing(message, this.ids); if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
            }
        };
        window.WebSocket = class extends NativeSocket {
            private readonly ids = new Set<number>();
            constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); observe(this, this.ids); }
            override send(data: Parameters<typeof NativeSocket.prototype.send>[0]) { outgoing(data, this.ids); super.send(data); }
        };
    });
    await page.goto(url); await page.locator("#sample").selectOption("errors");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click();
    const problem = page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2345:/ }), source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(problem).toBeEnabled();
    const marker = page.locator("#editor .st-diagnostic").first(), tooltip = page.getByRole("tooltip");
    await source.focus(); await marker.hover();
    await expect(tooltip).toContainText("is not assignable to parameter of type 'number'");
    await expect(source).toBeFocused(); await source.press("Escape"); await expect(tooltip).toBeHidden();
    await page.evaluate(() => { const p = (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe; p.hold = true; p.requests = []; });
    await source.press("Control+Home"); await page.keyboard.insertText("// retained 😀\n");
    await expect(problem).toBeVisible(); await expect(problem).toBeDisabled();
    await expect(page.locator("#panel-content")).toContainText("Awaiting recheck");
    await expect(marker).toHaveText('"10%"');
    await marker.hover(); await expect(tooltip).toContainText("Awaiting recheck.");
    await page.waitForFunction(() => (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.pending.length > 0);
    await page.evaluate(() => (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.release());
    await expect(page.locator("#language-status")).toHaveText("Language ready"); await expect(problem).toBeEnabled();
    await expect(tooltip).toContainText("is not assignable to parameter of type 'number'"); await expect(tooltip).not.toContainText("Awaiting recheck.");
    const requests = () => page.evaluate(() => (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.requests.map(p => `${p.uri.split("/").at(-1)}:${p.kind}`));
    const prefixRequests = await requests();
    expect(prefixRequests.sort()).toEqual(["main.ts:semantic", "main.ts:syntactic", "pricing.ts:semantic"]);
    await source.press("Control+z"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    await page.locator('#files [data-file="pricing.ts"]').click();
    const helper = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await page.evaluate(() => { (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.requests = []; });
    await helper.press("Control+a"); await page.keyboard.insertText('export interface CartItem { name: string; price: number; quantity: number; }\nexport function calculateTotal(items: readonly CartItem[], discount: number): string { return ""; }\n');
    const dependent = page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2551:/ });
    await expect(dependent).toBeEnabled(); await expect(dependent).toContainText("toFixed");
    const dependencyRequests = await requests();
    expect(dependencyRequests.sort()).toEqual(["main.ts:semantic", "pricing.ts:semantic", "pricing.ts:syntactic"]);
    await helper.press("Control+z"); await expect(dependent).toHaveCount(0); await expect(problem).toBeEnabled();
    await problem.click();
    await marker.hover(); await expect(tooltip).toContainText("is not assignable to parameter of type 'number'");
    await page.evaluate(() => { (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.hold = true; });
    await page.keyboard.insertText("0.1");
    await expect(problem).toHaveCount(0); await expect(marker).toHaveCount(0);
    await expect(tooltip).toBeHidden();
    await page.waitForFunction(() => (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.pending.length > 0);
    await page.evaluate(() => (window as unknown as { demoDiagnosticProbe: DiagnosticProbe }).demoDiagnosticProbe.release());
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    return { prefixRequests, dependencyRequests };
}
