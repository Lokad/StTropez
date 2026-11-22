import type { Observable } from "../../../src/index.ts";
import type { JsonValue, LspSession } from "../../../src/protocol/index.ts";
import type { TextEditor, CompletionSnippet, CompletionChoice } from "../../../src/browser/index.ts";

export type Diagnostic = Readonly<{ from: number; to: number; message: string }>;

export type ProviderSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null; diagnostics: readonly Diagnostic[]; diagnosticRevision: number; diagnosticsPending?: boolean;
    choices?: readonly string[]; choiceIndex?: number; completionAt: (index: number) => CompletionChoice | undefined; completionDetail?: string; resolving?: boolean; unversionedDiagnostics?: readonly string[]; snippet?: CompletionSnippet | null }>;
export type ProviderOptions = Readonly<{ autoConnect?: boolean; canCapture?: () => boolean; getPageSize?: () => number }>;
export type ProviderController = Observable<ProviderSnapshot> & Readonly<{ request: () => void;
    cancel: () => void; connect: () => void; disconnect: () => void; selectDiagnostic: (index: number) => boolean;
    setDelay: (value: number) => void; faultNext: (value: "malformed" | "failure") => void; dispose: () => void;
    customRequest?: (method: string, params: JsonValue) => Promise<JsonValue>;
    snapshot: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; outOfScope?: number; failed: number; postedUnits?: number;
        completionBeforeInputEvents?: number; lastCompletionBeforeInputMs?: number; completionCommands?: number; lastCompletionCommandMs?: number;
        connected: boolean; pending: boolean; offer: boolean; diagnostics: number; diagnosticRevision: number; diagnosticsPending?: boolean; transport?: "lsp3.17"; protocol?: ReturnType<LspSession["snapshotOwnership"]> }> }>;
export type ProviderFactory = (editor: TextEditor, options: ProviderOptions) => ProviderController;
