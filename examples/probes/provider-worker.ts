import { provide } from "./provider.ts";
import type { ProviderInput } from "./provider.ts";

// Dedicated real worker. Deliberately ignores cancellation to exercise late-result rejection.
globalThis.addEventListener("message", (event: MessageEvent<string>) => {
    const input = JSON.parse(event.data) as ProviderInput;
    setTimeout(() => {
        if (input.fault === "failure") throw new Error("Synthetic provider failure");
        globalThis.postMessage(input.fault === "malformed" ? JSON.stringify({ id: input.id, revision: input.revision, completion: { from: -1 }, diagnostics: [] }) : JSON.stringify(provide(input)));
    }, input.delay);
});
