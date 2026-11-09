import { provide } from "./provider.ts";
import type { ProviderInput } from "./provider.ts";
import { provideHover, validateHoverInput } from "./hover.ts";
import { NavigationSession, validateNavigationInput } from "./navigation.ts";

let navigation: NavigationSession | undefined, navigationFault: "malformed" | "failure" | undefined;

// Dedicated real worker. Deliberately ignores cancellation to exercise late-result rejection.
globalThis.addEventListener("message", (event: MessageEvent<string>) => {
    const decoded: unknown = JSON.parse(event.data);
    if (typeof decoded === "object" && decoded !== null && "operation" in decoded && typeof decoded.operation === "string" && decoded.operation.startsWith("navigation-")) {
        const id = "id" in decoded ? decoded.id : 0;
        if (decoded.operation === "navigation-start") {
            try {
                const input = validateNavigationInput(decoded); navigation = new NavigationSession(input); navigationFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic navigation failure"); globalThis.postMessage(JSON.stringify({ operation: "navigation-progress", id: input.id, received: 0 })); }, input.delay);
            } catch { globalThis.postMessage(JSON.stringify({ operation: "navigation-error", id })); }
        } else {
            try {
                if (!navigation) throw new Error("Navigation was not started.");
                const reply = navigation.handle(decoded);
                globalThis.postMessage(JSON.stringify(navigationFault === "malformed" && reply.operation === "navigation-result" ? { ...reply, locations: [...reply.locations as unknown[], { document: "unknown", revision: 0, from: 0, to: 1, declaration: true }] } : reply));
            } catch { globalThis.postMessage(JSON.stringify({ operation: "navigation-error", id })); }
        }
        return;
    }
    if (typeof decoded === "object" && decoded !== null && "operation" in decoded && decoded.operation === "hover") {
        const hover = validateHoverInput(decoded); if (!hover) return;
        setTimeout(() => {
            if (hover.fault === "failure") throw new Error("Synthetic hover failure");
            const result = provideHover(hover);
            globalThis.postMessage(JSON.stringify(hover.fault === "malformed" ? { ...result, range: { from: -1, to: 0 } }
                : hover.fault === "markup" && result.range ? { ...result, text: '<img src="invalid" onerror="window.hoverExecuted = true">\n<script>window.hoverExecuted = true</script>' } : result));
        }, hover.delay);
        return;
    }
    const input = decoded as ProviderInput;
    setTimeout(() => {
        if (input.fault === "failure") throw new Error("Synthetic provider failure");
        globalThis.postMessage(input.fault === "malformed" ? JSON.stringify({ id: input.id, revision: input.revision, completion: { from: -1 }, diagnostics: [] }) : JSON.stringify(provide(input)));
    }, input.delay);
});
