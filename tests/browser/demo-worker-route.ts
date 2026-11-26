import type { Page } from "@playwright/test";

type Direction = "client" | "worker";
type Delivery = Readonly<{ id: string; destination: Direction | "close"; data: string }>;
type Endpoint = { send(data: string): void; onMessage(receive: (data: string) => void): void };
type Route = { client: (data: string) => void; worker: (data: string) => void };

declare global {
    interface Window {
        demoWorkerRoute(id: string, source: Direction, data: string): Promise<void>;
        deliverDemoWorkerMessage(delivery: Delivery): void;
    }
}

/** Intercept JSON-RPC in the published language worker while leaving startup and other workers alone. */
export async function routeLanguageWorker(page: Page, connect: (client: Endpoint & { close(reason: string): void }, worker: Endpoint) => void) {
    const routes = new Map<string, Route>();
    await page.exposeBinding("demoWorkerRoute", ({ frame }, id: string, source: Direction, data: string) => {
        let route = routes.get(id);
        if (!route) {
            const deliver = (destination: Delivery["destination"], data: string) => {
                void frame.evaluate(delivery => window.deliverDemoWorkerMessage(delivery), { id, destination, data })
                    .catch(error => {
                        if (!frame.isDetached() && !page.isClosed() && !String(error).includes("Execution context was destroyed")) throw error;
                    });
            };
            const listeners: Route = { client: data => deliver("worker", data), worker: data => deliver("client", data) };
            const endpoint = (side: Direction): Endpoint => ({
                send: data => deliver(side, data),
                onMessage: receive => { listeners[side] = receive; },
            });
            connect({ ...endpoint("client"), close: reason => deliver("close", reason) }, endpoint("worker"));
            routes.set(id, listeners);
            route = listeners;
        }
        route[source](data);
    });
    await page.addInitScript(() => {
        const NativeWorker = Worker;
        const workers = new Map<string, Worker>();
        window.deliverDemoWorkerMessage = ({ id, destination, data }) => {
            const worker = workers.get(id);
            if (!worker) return;
            if (destination === "worker") NativeWorker.prototype.postMessage.call(worker, data);
            else if (destination === "close") worker.dispatchEvent(new ErrorEvent("error", { message: data, cancelable: true }));
            else worker.dispatchEvent(new MessageEvent("message", { data }));
        };
        window.Worker = class extends NativeWorker {
            private routeId?: string;
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (!new URL(url, document.baseURI).pathname.endsWith("/demo-language-worker.js")) return;
                const id = this.routeId = crypto.randomUUID();
                workers.set(id, this);
                this.addEventListener("message", event => {
                    if (!event.isTrusted || typeof event.data !== "string") return;
                    event.stopImmediatePropagation();
                    void window.demoWorkerRoute(id, "worker", event.data);
                });
            }
            override postMessage(data: unknown, options?: StructuredSerializeOptions | Transferable[]) {
                if (this.routeId && typeof data === "string") void window.demoWorkerRoute(this.routeId, "client", data);
                else if (Array.isArray(options)) super.postMessage(data, options);
                else super.postMessage(data, options);
            }
            override terminate() {
                if (this.routeId) workers.delete(this.routeId);
                super.terminate();
            }
        };
    });
}
