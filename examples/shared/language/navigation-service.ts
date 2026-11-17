import type { TextBuffer } from "../../../src/index.ts";
import type { LspSession } from "../../../src/protocol/index.ts";
import type { NavigationInput, NavigationResult } from "../../../fixtures/language/navigation.ts";

export type NavigationMetrics = { completed: number; failed: number };

export type NavigationOrigin = Readonly<{ document: string; offset: number }>;
export type NavigationService = Readonly<{
    run: (input: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (work: number) => void, origin: NavigationOrigin) => Promise<NavigationResult & Readonly<{ isCurrent?: () => boolean }>>;
    snapshot: () => Readonly<{ connected: boolean; busy: boolean; disposed: boolean; version: "LSP3.17"; epoch: number; sequence: number;
        documents: readonly Readonly<{ document: string; revision: number; length: number }>[]; protocol?: ReturnType<LspSession["snapshotOwnership"]> }>;
    dispose: () => void;
}>;
export type NavigationServiceFactory = Readonly<{
    create: (clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics, changed: () => void) => NavigationService }>;
