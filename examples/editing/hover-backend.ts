import type { DocumentSnapshot } from "../../src/index.ts";
import type { HoverInput } from "../probes/hover.ts";
export type AbsoluteHover = Readonly<{ revision: number; range: Readonly<{ from: number; to: number }> | null; text: string; isCurrent?: () => boolean }>;
export type HoverBackend = Readonly<{
    run: (document: DocumentSnapshot, offset: number, configuration: Pick<HoverInput, "delay" | "fault">) => Readonly<{ result: Promise<AbsoluteHover | null>; cancel: () => void }>;
    subscribe: (listener: () => void) => () => void; disconnect: () => void; dispose: () => void;
    snapshot: () => Readonly<{ connected: boolean; transport: "lsp3.17" }>;
}>;
