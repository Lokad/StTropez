import { cancelledRequest, staleRequest } from "./wire.ts";
import type { LspDocumentSnapshot } from "./lsp-session.ts";
import type { LspEditTarget } from "./lsp-features.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { TextBuffer } from "../core/text-buffer.ts";

export type LspTargetContext = Readonly<{ purpose: "navigation" | "edit"; source: LspDocumentSnapshot | null;
    isCurrent: () => boolean; onCancel: (listener: () => void) => () => void }>;
/** A project document, or read-only contents without a project resource. */
export type LspTargetSource = Readonly<({ document: DocumentSnapshot } | { text: string | TextBuffer; languageId: string }) & { release?: () => void }>;
export type LspTargetResolver = (uri: string, context: LspTargetContext) => Promise<LspTargetSource | undefined>;
export type LspResolvedTarget = Readonly<{ target: LspEditTarget; release: () => void }>;
export type ResolveRetainedTarget = (uri: string, context: LspTargetContext) => Promise<LspResolvedTarget | undefined>;
type Lifetime = Omit<LspTargetContext, "purpose"> & Readonly<{ reportError: (error: unknown) => void }>;
const stale = () => staleRequest("Captured LSP target loading expired.");

/** Shared by read results, text edits and server edit requests. No URI I/O occurs here. */
export function createLspTargets(captured: ReadonlyMap<string, LspEditTarget>, resolve: ResolveRetainedTarget, lifetime: Lifetime) {
    const targets = new Map(captured), captures = [...captured.values()], resolved = new Map<string, LspEditTarget>(),
        leases = new Set<LspResolvedTarget>(), listeners = new Set<() => void>();
    let disposed = false, stop = () => {}, reject!: (error: Error) => void;
    const cancellation = new Promise<never>((_yes, no) => { reject = no; }); void cancellation.catch(() => {});
    const live = () => !disposed && lifetime.isCurrent() && captures.every(target => target.isCurrent());
    const isCurrent = () => {
        if (!live()) return false;
        // Public target handles include the shared lifetime; aggregate checks use only
        // their local guards so each loaded URI does not recheck the complete project.
        for (const target of resolved.values()) if (!target.isCurrent()) return false;
        return true;
    };
    // A host release may update Workspace retention, which cannot run inside commit observers.
    const release = (lease: LspResolvedTarget) => { void Promise.resolve().then(lease.release).catch(lifetime.reportError); };
    const dispose = () => {
        if (disposed) return; disposed = true; stop(); reject(cancelledRequest("LSP target loading cancelled."));
        for (const listener of [...listeners]) { try { void Promise.resolve(listener()).catch(lifetime.reportError); } catch (error) { lifetime.reportError(error); } } listeners.clear();
        for (const lease of leases) release(lease); leases.clear();
    };
    stop = lifetime.onCancel(dispose); if (disposed) stop();
    return Object.freeze({ isCurrent, dispose, get: (uri: string) => targets.get(uri),
        resolve: async (uris: readonly string[], purpose: LspTargetContext["purpose"]) => {
            if (!isCurrent()) throw stale();
            const missing = [...new Set(uris)].filter(uri => !targets.has(uri));
            if (!missing.length) return;
            // A host can use this source/provider guard without recursively validating its own target.
            const context: LspTargetContext = Object.freeze({ purpose, source: lifetime.source, isCurrent: live,
                onCancel: listener => { let active = true;
                    const notify = () => { if (active) { active = false; return listener(); } };
                    if (!isCurrent()) void Promise.resolve().then(notify).catch(lifetime.reportError); else listeners.add(notify);
                    return () => { active = false; listeners.delete(notify); }; } });
            const pending = missing.values();
            let failed = false;
            async function load() {
                try {
                    for (const uri of pending) {
                        if (failed || !isCurrent()) throw stale();
                        const lease = await resolve(uri, context);
                        if (!lease) throw new TypeError(`LSP target is unavailable: ${uri}`);
                        // Own the lease before validating it so a failed or cancelled batch releases it.
                        if (disposed || failed) { release(lease); throw stale(); }
                        leases.add(lease);
                        const target = lease.target;
                        if (!isCurrent() || !target.isCurrent()) throw stale();
                        if (target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new TypeError("Resolved LSP target does not match its URI and buffer.");
                        resolved.set(uri, target);
                        targets.set(uri, Object.freeze({ ...target, isCurrent: () => live() && target.isCurrent() }));
                    }
                } catch (error) { failed = true; throw error; }
            }
            // Hosts can authorize and load independent navigation targets concurrently. Edits keep their original load order.
            const count = purpose === "navigation" ? Math.min(4, missing.length) : 1;
            try {
                await Promise.race([Promise.all(Array.from({ length: count }, () => Promise.resolve().then(load))), cancellation]);
                if (!isCurrent()) throw stale();
            } catch (error) { dispose(); throw error; }
        } });
}
