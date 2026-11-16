import type { DocumentSnapshot } from "../../../src/index.ts";
import type { HoverInput } from "../../../fixtures/language/hover.ts";
import type { DocumentationContent } from "../../../src/browser/index.ts";
export type AbsoluteHover = Readonly<{ revision: number; range: Readonly<{ from: number; to: number }> | null; text: string; content?: DocumentationContent; isCurrent?: () => boolean }>;
export type HoverBackend = Readonly<{
    run: (document: DocumentSnapshot, offset: number, configuration: Pick<HoverInput, "delay" | "fault">) => Readonly<{ result: Promise<AbsoluteHover | null>; cancel: () => void }>;
    subscribe: (listener: () => void) => () => void; disconnect: () => void; dispose: () => void;
    snapshot: () => Readonly<{ connected: boolean; transport: "lsp3.17" }>;
}>;
