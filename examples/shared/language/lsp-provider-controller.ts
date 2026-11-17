import { createLspEditor } from "../../../src/browser/index.ts";
import type { TextEditor } from "../../../src/browser/index.ts";
import type { TabId, Workspace } from "../../../src/index.ts";
import type { LspScopeAccess, LspWorkspace } from "../../../src/protocol/index.ts";
import type { ProviderController, ProviderOptions } from "./provider-contract.ts";

export type LspProviderOptions = ProviderOptions & Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspScopeAccess, configuration: Readonly<{ delay: number; fault?: "malformed" | "failure" }>) => Promise<unknown> }>;

/** Development-only fault/delay controls around the same public editor integration. */
export function createLspProviderController(workspace: Workspace, tabId: TabId, editor: TextEditor, options: LspProviderOptions): ProviderController {
    let delay = 0, fault: "malformed" | "failure" | undefined;
    const controller = createLspEditor(workspace, tabId, editor, { ...options,
        prepareCompletion: async session => { const nextFault = fault; fault = undefined;
            await options.beforeRequest?.(session, { delay, ...(nextFault ? { fault: nextFault } : {}) }); } });
    return Object.freeze({ ...controller,
        disconnect: () => { controller.cancel(); options.provider.disconnect(); },
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid fixture delay."); delay = value; },
        faultNext: (value: "malformed" | "failure") => { fault = value; },
        snapshot: controller.snapshot });
}
