import { provide } from "./provider.ts";
import type { ProviderInput } from "./provider.ts";
import { provideHover, validateHoverInput } from "./hover.ts";

// Dedicated real worker. Deliberately ignores cancellation to exercise late-result rejection.
globalThis.addEventListener("message", (event: MessageEvent<string>) => {
    const decoded: unknown = JSON.parse(event.data);
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
