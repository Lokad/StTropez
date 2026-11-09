import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";
import type { DocumentId, HistorySnapshot, Selection, TextEdit, TextResourceHandle } from "../../src/index.ts";

type TransferTargetSnapshot = Readonly<{ documentId: DocumentId; revision: number; text: string; exports: number; history: HistorySnapshot }>;

export function installHostHarness(controller: HostController, bindings: ViewBindings, mode: "plain" | "react",
    mount: () => void, unmount: () => void, commits: () => Readonly<{ form: number; metadata: number }>): void {
    let disposed = false;
    let transferTarget: TextResourceHandle | undefined;
    const transferSnapshot = (): TransferTargetSnapshot => {
        if (!transferTarget) throw new Error("No transfer target is mounted.");
        const current = controller.workspace.document(transferTarget.documentId);
        return { documentId: transferTarget.documentId, revision: current.revision, text: current.buffer.slice(0, current.buffer.length),
            exports: current.buffer.readMetrics().textExports, history: controller.workspace.observeHistory(transferTarget.documentId).getSnapshot() };
    };
    const attach = () => { if (disposed) throw new Error("Host fixture is disposed."); mount(); };
    const recover = () => { controller.recover(); attach(); };
    const listeners = new AbortController();
    document.getElementById("recover")!.addEventListener("click", recover, { signal: listeners.signal });
    const dispose = async () => { disposed = true; listeners.abort(); unmount(); bindings.dispose();
        if (transferTarget) { controller.workspace.close(controller.viewTab("secondary")); controller.workspace.releaseResource(transferTarget.id, true); transferTarget = undefined; }
        await controller.dispose(); };
    window.addEventListener("pagehide", () => { void dispose(); }, { once: true, signal: listeners.signal });
    controller.startBackground(); mount();
    const fixture = Object.freeze({ ready: true, mode, snapshot: () => { const state = controller.debug(), views = bindings.debug();
        return { ...state, hostSubscriptions: state.hostSubscriptions + views.language.subscriptions + views.hover.subscriptions + views.tablePaste.subscriptions, bindings: views, commits: commits() }; },
        editSource: (expectedRevision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: controller.source.documentId,
            expectedRevision, edits, origin: "host", history: { kind: "live" } }),
        deliverProposal: controller.deliverProposalText, runCapture: (index: number) => controller.runCapture(index), setPath: controller.setPath, recoveryText: () => controller.recoveryText(),
        finishRun: controller.finishRun, failRun: controller.failRun, finishSave: controller.finishSave, failSave: controller.failSave,
        externalWrite: (text: string) => controller.externalWrite(text), finishConflictReview: controller.finishConflictReview, saveReviewedSource: controller.saveReviewedSource,
        range: (from: number, to: number) => controller.workspace.document(controller.source.documentId).buffer.slice(from, to),
        referenceRange: (from: number, to: number) => bindings.referenceRange(from, to),
        selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => bindings.selectSource(id, revision, selection),
        selectSourceSet: (id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary = 0) => bindings.selectSourceSet(id, revision, ranges, primary),
        setSourceReadOnly: (value: boolean) => controller.workspace.setCapabilities(controller.source.id, { edit: value ? ["host"] : ["human", "host", "agent"], save: true, run: true }),
        cycleSourceEditLease: () => { const lease = controller.workspace.acquireEditLease(controller.source.id, "host-fixture", "host"); lease.release(); },
        openTransferTarget: (text: string) => {
            if (disposed || transferTarget) throw new Error("Transfer target cannot be mounted.");
            unmount(); transferTarget = controller.workspace.createTextResource({ scope: "host-fixture", resource: "transfer", variant: "working" }, "Transfer target", { value: text });
            controller.workspace.replace(controller.viewTab("secondary"), { kind: "text", documentId: transferTarget.documentId }); attach();
        },
        transferSnapshot,
        editTransferTarget: (expectedRevision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: transferSnapshot().documentId, expectedRevision, edits, origin: "host" }),
        setTransferReadOnly: (value: boolean) => { if (!transferTarget) throw new Error("No transfer target is mounted.");
            controller.workspace.setCapabilities(transferTarget.id, { edit: value ? ["host"] : ["human", "host"], save: true, run: false }); },
        setProviderDelay: (delay: number) => bindings.language.setDelay(delay), faultProviderNext: (fault: "malformed" | "failure") => bindings.language.faultNext(fault),
        requestProvider: bindings.language.request,
        inspectSymbol: (id: "primary" | "secondary" | "comparison") => bindings.hover.inspectCaret(id),
        setHoverDelay: (id: string, value: number) => bindings.hover.setDelay(id, value),
        faultHoverNext: (id: string, value: "malformed" | "failure" | "markup") => bindings.hover.faultNext(id, value),
        unmount, mount: attach, dispose });
    window.hostFixture = fixture;
}
declare global { interface Window { hostFixture: Readonly<{ ready: boolean; mode: string; snapshot: () => ReturnType<HostController["debug"]> &
    { bindings: ReturnType<ViewBindings["debug"]>; commits: Readonly<{ form: number; metadata: number }> };
    editSource: (expectedRevision: number, edits: readonly TextEdit[]) => ReturnType<HostController["workspace"]["edit"]>;
    deliverProposal: (text: string) => void; runCapture: (index: number) => ReturnType<HostController["runCapture"]>; setPath: (path: string) => void;
    recoveryText: () => string | null;
    finishRun: () => void; failRun: () => void; finishSave: () => void; failSave: () => void; range: (from: number, to: number) => string;
    externalWrite: (text: string) => void; finishConflictReview: () => boolean; saveReviewedSource: () => void;
    referenceRange: (from: number, to: number) => string | undefined;
    selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => boolean;
    selectSourceSet: (id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary?: number) => boolean;
    setSourceReadOnly: (value: boolean) => void;
    cycleSourceEditLease: () => void;
    openTransferTarget: (text: string) => void; transferSnapshot: () => TransferTargetSnapshot;
    editTransferTarget: (expectedRevision: number, edits: readonly TextEdit[]) => ReturnType<HostController["workspace"]["edit"]>;
    setTransferReadOnly: (value: boolean) => void;
    setProviderDelay: (delay: number) => void; faultProviderNext: (fault: "malformed" | "failure") => void;
    requestProvider: () => void;
    inspectSymbol: (id: "primary" | "secondary" | "comparison") => boolean;
    setHoverDelay: (id: string, value: number) => void;
    faultHoverNext: (id: string, value: "malformed" | "failure" | "markup") => void;
    unmount: () => void; mount: () => void; dispose: () => Promise<void> }> } }
