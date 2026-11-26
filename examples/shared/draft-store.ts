export type StoredDraft = Readonly<{ token: string; value: unknown }>;
export type DraftStore = Readonly<{
    read: () => Promise<StoredDraft | null>;
    write: (value: StoredDraft, expected: string | null) => Promise<void>;
    remove: (expected: string) => Promise<void>;
    watch: (changed: () => void) => () => void;
    close: () => Promise<void>;
}>;

/** Example-host service. The editor package never opens storage. */
export function createBrowserDraftStore(
    owner: Window & typeof globalThis,
    options: Readonly<{ name?: string; slot?: string }> = {}
): DraftStore {
    const name = options.name ?? "sttropez-example-drafts-v1",
        slot = options.slot ?? "working-inputs",
        watchers = new Set<() => void>();
    let opening: Promise<IDBDatabase> | undefined,
        closed = false;
    let channel: BroadcastChannel | undefined;
    try {
        channel = new owner.BroadcastChannel(name);
        channel.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (!data || typeof data !== "object" || !("slot" in data) || data.slot !== slot) return;
            for (const changed of [...watchers]) changed();
        };
    } catch {
        /* Storage operations still enforce captured tokens. */
    }
    const database = () =>
        (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            try {
                const request = owner.indexedDB.open(name, 1);
                let failed = false;
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains("drafts")) request.result.createObjectStore("drafts");
                };
                request.onerror = () => {
                    failed = true;
                    reject(request.error);
                };
                request.onblocked = () => {
                    failed = true;
                    reject(new Error("Recovery database upgrade is blocked."));
                };
                request.onsuccess = () => {
                    const db = request.result;
                    if (failed || closed) {
                        db.close();
                        reject(new Error("Recovery store is closed."));
                        return;
                    }
                    db.onversionchange = () => {
                        db.close();
                        opening = undefined;
                        for (const changed of [...watchers]) changed();
                    };
                    resolve(db);
                };
            } catch (error) {
                reject(error);
            }
        }).catch((error) => {
            opening = undefined;
            throw error;
        }));
    const envelope = (raw: unknown): StoredDraft | null =>
        raw === undefined
            ? null
            : Object.freeze({
                  token:
                      !!raw && typeof raw === "object" && "token" in raw && typeof raw.token === "string"
                          ? raw.token
                          : "invalid",
                  value: !!raw && typeof raw === "object" && "value" in raw ? raw.value : raw
              });
    const transact = async (
        change?: Readonly<{ expected: string | null; value?: StoredDraft }>
    ): Promise<StoredDraft | null> => {
        const db = await database();
        if (closed) throw new Error("Recovery store is closed.");
        return new Promise((resolve, reject) => {
            const tx = change
                ? db.transaction("drafts", "readwrite", { durability: "strict" })
                : db.transaction("drafts", "readonly");
            const store = tx.objectStore("drafts"),
                get = store.get(slot);
            let result: StoredDraft | null = null,
                failure: unknown;
            tx.oncomplete = () => {
                resolve(result);
                if (change)
                    try {
                        channel?.postMessage({ slot });
                    } catch {
                        /* Token checks remain authoritative if notification fails. */
                    }
            };
            tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("Recovery transaction failed."));
            get.onsuccess = () => {
                try {
                    result = envelope(get.result);
                    if (change) {
                        if ((result?.token ?? null) !== change.expected)
                            throw new Error("The stored draft changed in another page.");
                        if (change.value) store.put(change.value, slot);
                        else store.delete(slot);
                    }
                } catch (error) {
                    failure = error;
                    tx.abort();
                }
            };
        });
    };
    return Object.freeze({
        read: () => transact(),
        write: async (value, expected) => {
            await transact({ value, expected });
        },
        remove: async (expected) => {
            await transact({ expected });
        },
        watch: (changed) => {
            watchers.add(changed);
            return () => {
                watchers.delete(changed);
            };
        },
        close: async () => {
            closed = true;
            channel?.close();
            watchers.clear();
            if (opening)
                try {
                    (await opening).close();
                } catch {
                    /* Already unavailable. */
                }
        }
    });
}
