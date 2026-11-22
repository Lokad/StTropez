import type { RpcTransport } from "../../src/protocol/index.ts";

/** Example host bootstrap; never part of the shipped editor package. */
export type DemoProviderBootstrap = Readonly<{ endpoint: string; rootUri: string;
    documents: Readonly<Record<string, Readonly<{ uri: string; path: string }>>>;
    versions: Readonly<{ server: string; typescript: string; protocol: string; positions: string }> }>;

export type DemoProvider = DemoProviderBootstrap & Readonly<{
    connect: (signal: AbortSignal) => Promise<RpcTransport>;
    close: () => Promise<void>;
}>;
export type DemoProviderFactory = (sample: string, signal: AbortSignal, names: readonly string[], backing?: Readonly<Record<string, string>>) => Promise<DemoProvider>;
