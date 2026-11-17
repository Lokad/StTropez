import { cancelledRequest, staleRequest } from "./wire.ts";
import type { LspDocumentSnapshot } from "./lsp-session.ts";
import type { LspEditTarget } from "./lsp-features.ts";

export type LspTargetContext = Readonly<{ purpose: "navigation" | "edit"; source: LspDocumentSnapshot | null;
    isCurrent: () => boolean; onCancel: (listener: () => void) => () => void }>;
/** The host retains the exact resource/buffer until release; loading grants no edit authority. */
export type LspResolvedTarget = Readonly<{ target: LspEditTarget; release: () => void }>;
export type LspTargetResolver = (uri: string, context: LspTargetContext) => Promise<LspResolvedTarget | undefined>;
type Lifetime = Omit<LspTargetContext, "purpose"> & Readonly<{ reportError: (error: unknown) => void }>;
const stale = () => staleRequest("Captured LSP target loading expired.");

/** Shared by read results, text edits and server edit requests. No URI I/O occurs here. */
export function createLspTargets(captured: ReadonlyMap<string, LspEditTarget>, resolve: LspTargetResolver, lifetime: Lifetime) {
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
            for (const uri of new Set(uris)) {
                if (targets.has(uri)) continue;
                // Expose source/provider intent independently of resolved target guards. A host
                // can reuse this check in its target guard without recursive target validation.
                const context: LspTargetContext = Object.freeze({ purpose, source: lifetime.source, isCurrent: live,
                    onCancel: listener => { let active = true;
                        const notify = () => { if (active) { active = false; return listener(); } };
                        if (!isCurrent()) void Promise.resolve().then(notify).catch(lifetime.reportError); else listeners.add(notify);
                        return () => { active = false; listeners.delete(notify); }; } });
                const loading = Promise.resolve().then(() => {
                    if (!isCurrent()) throw stale(); return resolve(uri, context);
                }).then(lease => {
                    if (!lease) throw new TypeError(`LSP target is unavailable: ${uri}`);
                    let retained = false;
                    try {
                        if (!isCurrent() || !lease.target.isCurrent()) throw stale();
                        const target = lease.target;
                        if (target.document.uri !== uri || target.index.buffer !== target.document.buffer) throw new TypeError("Resolved LSP target does not match its URI and buffer.");
                        const guarded = Object.freeze({ ...target, isCurrent: () => live() && target.isCurrent() });
                        resolved.set(uri, target); targets.set(uri, guarded); leases.add(lease); retained = true;
                    } finally { if (!retained) release(lease); }
                });
                await Promise.race([loading, cancellation]);
                if (!isCurrent()) throw stale();
            }
        } });
}
