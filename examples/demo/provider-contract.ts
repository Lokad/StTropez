/** Development host bootstrap; never part of the shipped editor package. */
export type DemoProviderBootstrap = Readonly<{ endpoint: string; rootUri: string;
    documents: Readonly<Record<string, Readonly<{ uri: string; path: string }>>>;
    versions: Readonly<{ server: string; typescript: string; protocol: string; positions: string }> }>;
