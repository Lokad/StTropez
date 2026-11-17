import type { Observable, TabId, Workspace } from "../../../src/index.ts";
import type { JsonValue, LspSession } from "../../../src/protocol/index.ts";
import type { TextEditor, LspEditorSnippet } from "../../../src/browser/index.ts";

export type Diagnostic = Readonly<{ from: number; to: number; message: string }>;

export type ProviderSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null; diagnostics: readonly Diagnostic[]; diagnosticRevision: number; diagnosticsPending?: boolean;
    choices?: readonly string[]; choiceIndex?: number; completionId?: number; completionDetail?: string; resolving?: boolean; unversionedDiagnostics?: readonly string[]; snippet?: LspEditorSnippet | null }>;
export type ProviderOptions = Readonly<{ autoConnect?: boolean; canCapture?: () => boolean }>;
export type ProviderController = Readonly<{ state: Observable<ProviderSnapshot>; request: () => void; apply: (mode: "insert" | "replace", completionId?: number) => boolean;
    cancel: () => void; connect: () => void; disconnect: () => void; selectDiagnostic: (index: number) => boolean; chooseCompletion: (index: number, completionId?: number) => boolean;
    setDelay: (value: number) => void; faultNext: (value: "malformed" | "failure") => void; destroy: () => void;
    customRequest?: (method: string, params: JsonValue) => Promise<JsonValue>;
    snapshot: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; outOfScope?: number; failed: number; postedUnits?: number;
        completionBeforeInputEvents?: number; lastCompletionBeforeInputMs?: number; completionKeydownEvents?: number; lastCompletionKeydownMs?: number;
        connected: boolean; pending: boolean; offer: boolean; diagnostics: number; diagnosticRevision: number; diagnosticsPending?: boolean; transport?: "worker-v1" | "lsp3.17"; protocol?: ReturnType<LspSession["snapshotOwnership"]> }> }>;
export type ProviderFactory = (workspace: Workspace, tabId: TabId, editor: TextEditor, options: ProviderOptions) => ProviderController;
