import { provide } from "./provider.ts";
import type { ProviderInput } from "./provider.ts";
import { provideHover, validateHoverInput } from "./hover.ts";
import { validateNavigationInput } from "./navigation.ts";
import { ProviderProject, projectProtocolVersion } from "./project.ts";
import { validateProjectCommand } from "./project-commands.ts";

let project: ProviderProject | undefined, navigationFault: "malformed" | "failure" | undefined;
let loseCommandAcknowledgement = false;

// Host worker entry. Owners control their lanes; deferred replies exercise stale-result rejection.
globalThis.addEventListener("message", (event: MessageEvent<string>) => {
    const decoded: unknown = JSON.parse(event.data);
    if (typeof decoded === "object" && decoded !== null && "operation" in decoded && typeof decoded.operation === "string" && decoded.operation.startsWith("project-")) {
        try {
            if (!project) { if (decoded.operation !== "project-hello" || !("epoch" in decoded) || typeof decoded.epoch !== "number") throw new Error("Initialize the provider."); project = new ProviderProject(decoded.epoch); }
            const reply = project.handle(decoded);
            if (decoded.operation === "project-command" && "input" in decoded) {
                const input = validateProjectCommand(decoded.input); loseCommandAcknowledgement = input.fault === "ack";
                setTimeout(() => {
                    if (input.fault === "failure") throw new Error("Synthetic project command failure");
                    globalThis.postMessage(JSON.stringify(input.fault === "malformed" ? { ...reply, edits: [...(reply.edits as readonly unknown[] ?? []).slice(0, -1), { document: "unknown", revision: 0, edits: [{ from: 0, to: 0, insert: "invalid" }] }] } : reply));
                }, input.delay);
            } else if (decoded.operation === "project-server-result" && loseCommandAcknowledgement) {
                setTimeout(() => { throw new Error("Synthetic server acknowledgement loss"); }, 0);
            } else if (decoded.operation === "project-query" && "input" in decoded) {
                const input = validateNavigationInput(decoded.input); navigationFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic navigation failure"); globalThis.postMessage(JSON.stringify(reply)); }, input.delay);
            } else {
                const result = reply.result as Readonly<{ locations: readonly unknown[] }> | undefined;
                globalThis.postMessage(JSON.stringify(navigationFault === "malformed" && reply.operation === "project-query-result" && result
                    ? { ...reply, result: { ...result, locations: [...result.locations, { document: "unknown", revision: 0, from: 0, to: 1, declaration: true }] } } : reply));
            }
        } catch { globalThis.postMessage(JSON.stringify({ version: projectProtocolVersion, epoch: project?.epoch ?? 0,
            sequence: "sequence" in decoded ? decoded.sequence : 0, operation: "project-error" })); }
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
