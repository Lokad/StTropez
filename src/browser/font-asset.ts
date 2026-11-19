import { NotificationScope, Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";

export type FontAssetVersion = Readonly<{ fontId: string; generation: number; family: string }>;
export type FontAssetSnapshot = Readonly<{ fontId: string; generation: number; status: "idle" | "loading" | "ready" | "failed" | "disposed";
    current: FontAssetVersion | null; failure: string | null }>;
export type FontLoadResult = Readonly<{ generation: number; status: "ready" | "stale" | "failed" | "disposed" }>;
export type FontLoadOperation = Readonly<{ generation: number; settled: Promise<FontLoadResult> }>;
export type FontAssetController = Observable<FontAssetSnapshot> & Readonly<{
    request: (expectedGeneration: number, bytes: Uint8Array) => FontLoadOperation | null;
    isCurrent: (generation: number) => boolean; cancel: () => void; dispose: () => void;
}>;

/** Explicitly owned single-face font assets. The host decides which views use the returned family. */
export function createFontAssetController(owner: Document, fontId: string,
    options: Readonly<{ onListenerError?: (error: unknown) => void }> = {}): FontAssetController {
    if (!fontId) throw new TypeError("A font resource identity is required.");
    const win = owner.defaultView; if (!win || !owner.fonts || !win.FontFace) throw new Error("Font loading is unavailable.");
    const scope = new NotificationScope(options.onListenerError ?? (() => {})), store = new Store<FontAssetSnapshot>(Object.freeze({ fontId, generation: 0, status: "idle", current: null, failure: null }), scope);
    let disposed = false, currentFace: FontFace | undefined;
    const publish = (next: FontAssetSnapshot) => { scope.publish(store, Object.freeze(next)); };
    const live = (generation: number) => !disposed && store.get().generation === generation;
    return Object.freeze({ ...store.observable,
        request: (expectedGeneration: number, input: Uint8Array) => {
            scope.assertWritable(); if (disposed) throw new Error("Font asset is disposed.");
            if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new RangeError("Invalid font generation.");
            if (expectedGeneration !== store.get().generation) return null;
            const bytes = new Uint8Array(input);
            const nonce = Array.from(win.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, "0")).join("");
            const face = new win.FontFace(`_stfont_${nonce}`, bytes.buffer), generation = store.get().generation + 1;
            publish({ ...store.get(), generation, status: "loading", failure: null });
            const failed = (error: unknown): FontLoadResult => {
                if (!live(generation)) return Object.freeze({ generation, status: disposed ? "disposed" : "stale" });
                publish({ ...store.get(), status: "failed", failure: error instanceof Error ? error.message : "Native font loading failed." });
                return Object.freeze({ generation, status: "failed" });
            };
            const settled = face.load().then((): FontLoadResult => {
                if (!live(generation)) return Object.freeze({ generation, status: disposed ? "disposed" : "stale" });
                const previous = currentFace; try { owner.fonts.add(face); } catch (error) { return failed(error); } currentFace = face;
                const current = Object.freeze({ fontId, generation, family: face.family });
                publish({ fontId, generation, status: "ready", current, failure: null }); if (previous) owner.fonts.delete(previous);
                return Object.freeze({ generation, status: "ready" });
            }, failed);
            return Object.freeze({ generation, settled });
        },
        isCurrent: (generation: number) => !disposed && store.get().current?.generation === generation && !!currentFace && owner.fonts.has(currentFace),
        cancel: () => { scope.assertWritable(); if (disposed) return; const previous = store.get(); publish({ ...previous, generation: previous.generation + 1, status: previous.current ? "ready" : "idle", failure: null }); },
        dispose: () => { scope.assertWritable(); if (disposed) return; disposed = true; if (currentFace) owner.fonts.delete(currentFace); currentFace = undefined;
            publish({ fontId, generation: store.get().generation + 1, status: "disposed", current: null, failure: null }); }
    });
}
