import type { TextBuffer } from "../../../src/index.ts";
import type { LspSession } from "../../../src/protocol/index.ts";
import type { NavigationInput, NavigationResult } from "../../../fixtures/language/navigation.ts";

export type NavigationMetrics = { created: number; posted: number; received: number; transferred: number; maxChunk: number; completed: number; failed: number; terminated: number;
    opened: number; changed: number; closed: number; reused: number; snapshotUnits: number; deltaUnits: number; planningTurns: number; rejected: number };
export type SyncFault = "version" | "epoch" | "sequence" | "revision";
export function navigationMetrics(): NavigationMetrics { return { created: 0, posted: 0, received: 0, transferred: 0, maxChunk: 0, completed: 0, failed: 0, terminated: 0,
    opened: 0, changed: 0, closed: 0, reused: 0, snapshotUnits: 0, deltaUnits: 0, planningTurns: 0, rejected: 0 }; }

export type NavigationOrigin = Readonly<{ document: string; offset: number }>;
export type NavigationService = Readonly<{
    run: (input: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (work: number) => void, fault?: SyncFault, origin?: NavigationOrigin) => Promise<NavigationResult & Readonly<{ isCurrent?: () => boolean }>>;
    snapshot: () => Readonly<{ connected: boolean; busy: boolean; disposed: boolean; version: number | "LSP3.17"; epoch: number; sequence: number;
        documents: readonly Readonly<{ document: string; revision: number; length: number }>[]; protocol?: ReturnType<LspSession["snapshotOwnership"]> }>;
    dispose: () => void;
}>;
export type NavigationServiceFactory = Readonly<{ positionQueries: boolean;
    create: (clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics, changed: () => void) => NavigationService }>;
