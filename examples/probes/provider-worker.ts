import { provide } from "../../fixtures/language/provider.ts";
import type { ProviderInput } from "../../fixtures/language/provider.ts";
import { provideHover, validateHoverInput } from "../../fixtures/language/hover.ts";
import { validateNavigationInput } from "../../fixtures/language/navigation.ts";
import { ProviderProject, projectProtocolVersion } from "../../fixtures/language/project.ts";
import { validateProjectCommand } from "../../fixtures/language/project-commands.ts";
import { validateSignatureInput } from "../../fixtures/language/signature.ts";
import type { SignatureInput, SignatureResult } from "../../fixtures/language/signature.ts";
import { validateActionInput } from "../../fixtures/language/actions.ts";
import type { ActionInput, ActionResult } from "../../fixtures/language/actions.ts";
import { validateLinksInput } from "../../fixtures/language/links.ts";
import type { LinksInput, LinksResult } from "../../fixtures/language/links.ts";
import { validateColorsInput } from "../../fixtures/language/colors.ts";
import type { ColorFault, ColorsResult, ColorPresentationsResult } from "../../fixtures/language/colors.ts";

let project: ProviderProject | undefined, navigationFault: "malformed" | "failure" | undefined;
let loseCommandAcknowledgement = false;
let signatureFault: SignatureInput["fault"];
let actionFault: ActionInput["fault"];
let linksFault: LinksInput["fault"];
let colorsFault: ColorFault | undefined;

// Host worker entry. Owners control their lanes; deferred replies exercise stale-result rejection.
globalThis.addEventListener("message", (event: MessageEvent<string>) => {
    const decoded: unknown = JSON.parse(event.data);
    if (typeof decoded === "object" && decoded !== null && "operation" in decoded && typeof decoded.operation === "string" && decoded.operation.startsWith("project-")) {
        try {
            if (!project) { if (decoded.operation !== "project-hello" || !("epoch" in decoded) || typeof decoded.epoch !== "number") throw new Error("Initialize the provider."); project = new ProviderProject(decoded.epoch); }
            const reply = project.handle(decoded);
            if (decoded.operation === "project-colors" && "input" in decoded) {
                const input = validateColorsInput(decoded.input); colorsFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic colors failure"); globalThis.postMessage(JSON.stringify(reply)); }, input.delay);
            } else if (reply.operation === "project-colors-result") {
                const result = reply.result as ColorsResult;
                globalThis.postMessage(JSON.stringify(colorsFault === "malformed" ? { ...reply, result: { ...result, colors: [...result.colors, { from: -1, to: 0, text: "invalid", label: "invalid", color: { red: 2, green: 0, blue: 0, alpha: 1 } }] } }
                    : colorsFault === "incomplete" ? { ...reply, result: { ...result, complete: false } }
                    : colorsFault === "markup" ? { ...reply, result: { ...result, colors: result.colors.map((color, i) => i ? color : { ...color, label: '<img src="invalid" onerror="window.colorExecuted = true">' }) } } : reply));
            } else if (decoded.operation === "project-color-presentations" && "input" in decoded) {
                const input = validateColorsInput(decoded.input), result = reply.result as ColorPresentationsResult;
                setTimeout(() => {
                    if (input.fault === "failure") throw new Error("Synthetic presentation failure");
                    globalThis.postMessage(JSON.stringify(input.fault === "incomplete" ? { ...reply, result: { ...result, complete: false } }
                        : input.fault === "malformed" ? { ...reply, result: { ...result, presentations: result.presentations.map((p, i) => i !== result.presentations.length - 1 ? p : { ...p, edits: [{ document: result.document, revision: result.revision, edits: [{ from: result.from, to: result.to, insert: "#123456" }, { from: -1, to: 0, insert: "invalid late edit" }] }] }) } }
                        : input.fault === "markup" ? { ...reply, result: { ...result, presentations: result.presentations.map((p, i) => i ? p : { ...p, label: '<img src="invalid" onerror="window.colorExecuted = true">' }) } } : reply));
                }, input.delay);
            } else if (decoded.operation === "project-links" && "input" in decoded) {
                const input = validateLinksInput(decoded.input); linksFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic links failure"); globalThis.postMessage(JSON.stringify(reply)); }, input.delay);
            } else if (reply.operation === "project-links-result") {
                const result = reply.result as LinksResult;
                globalThis.postMessage(JSON.stringify(linksFault === "malformed" ? { ...reply, result: { ...result, links: [...result.links, { from: -1, to: 0, module: "invalid", tooltip: "invalid", target: "javascript:invalid()" }] } }
                    : linksFault === "incomplete" ? { ...reply, result: { ...result, complete: false } }
                    : linksFault === "markup" ? { ...reply, result: { ...result, links: result.links.map((link, i) => i ? link : { ...link, tooltip: '<img src="invalid" onerror="window.linkExecuted = true">' }) } } : reply));
            } else if (decoded.operation === "project-action" && "input" in decoded) {
                const input = validateActionInput(decoded.input); actionFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic action failure"); globalThis.postMessage(JSON.stringify(reply)); }, input.delay);
            } else if (reply.operation === "project-action-result") {
                const result = reply.result as ActionResult, action = result.action;
                globalThis.postMessage(JSON.stringify(actionFault === "malformed" ? { ...reply, result: { ...result, action: { ...action, disabled: null, edits: [{ document: result.document, revision: result.revision, edits: [{ from: 0, to: 0, insert: "valid prefix" }, { from: -1, to: 0, insert: "invalid late edit" }] }] } } }
                    : actionFault === "incomplete" ? { ...reply, result: { ...result, complete: false } }
                    : actionFault === "markup" ? { ...reply, result: { ...result, action: { ...action, title: '<img src="invalid" onerror="window.actionExecuted = true">' } } } : reply));
            } else if (decoded.operation === "project-signature" && "input" in decoded) {
                const input = validateSignatureInput(decoded.input); signatureFault = input.fault;
                setTimeout(() => { if (input.fault === "failure") throw new Error("Synthetic signature failure"); globalThis.postMessage(JSON.stringify(reply)); }, input.delay);
            } else if (reply.operation === "project-signature-result") {
                const result = reply.result as SignatureResult;
                globalThis.postMessage(JSON.stringify(signatureFault === "malformed" ? { ...reply, result: { ...result, signatures: [...result.signatures, { label: "invalid", documentation: "", parameters: [{ from: -1, to: 1, documentation: "" }] }] } }
                    : signatureFault === "markup" && result.signatures.length ? { ...reply, result: { ...result, signatures: result.signatures.map((s, i) => i ? s : { ...s, documentation: '<img src="invalid" onerror="window.signatureExecuted = true">' }) } } : reply));
            } else if (decoded.operation === "project-command" && "input" in decoded) {
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
