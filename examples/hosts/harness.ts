import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";
import type { Selection, TextEdit } from "../../src/index.ts";

export function installHostHarness(controller: HostController, bindings: ViewBindings, mode: "plain" | "react",
    mount: () => void, unmount: () => void, commits: () => Readonly<{ form: number; metadata: number }>): void {
    let disposed = false;
    const attach = () => { if (disposed) throw new Error("Host fixture is disposed."); mount(); };
    const recover = () => { controller.recover(); attach(); };
    const listeners = new AbortController();
    document.getElementById("recover")!.addEventListener("click", recover, { signal: listeners.signal });
    const dispose = async () => { disposed = true; listeners.abort(); unmount(); bindings.dispose(); await controller.dispose(); };
    window.addEventListener("pagehide", () => { void dispose(); }, { once: true, signal: listeners.signal });
    controller.startBackground(); mount();
    const fixture = Object.freeze({ ready: true, mode, snapshot: () => { const state = controller.debug(), views = bindings.debug();
        return { ...state, hostSubscriptions: state.hostSubscriptions + views.language.subscriptions, bindings: views, commits: commits() }; },
        editSource: (expectedRevision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: controller.source.documentId,
            expectedRevision, edits, origin: "host", history: { kind: "live" } }),
        deliverProposal: controller.deliverProposalText, runCapture: (index: number) => controller.runCapture(index), setPath: controller.setPath, recoveryText: () => controller.recoveryText(),
        finishRun: controller.finishRun, failRun: controller.failRun, finishSave: controller.finishSave, failSave: controller.failSave,
        externalWrite: (text: string) => controller.externalWrite(text), finishConflictReview: controller.finishConflictReview, saveReviewedSource: controller.saveReviewedSource,
        range: (from: number, to: number) => controller.workspace.document(controller.source.documentId).buffer.slice(from, to),
        referenceRange: (from: number, to: number) => bindings.referenceRange(from, to),
        selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => bindings.selectSource(id, revision, selection),
        setProviderDelay: (delay: number) => bindings.language.setDelay(delay), faultProviderNext: (fault: "malformed" | "failure") => bindings.language.faultNext(fault),
        requestProvider: bindings.language.request,
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
    setProviderDelay: (delay: number) => void; faultProviderNext: (fault: "malformed" | "failure") => void;
    requestProvider: () => void;
    unmount: () => void; mount: () => void; dispose: () => Promise<void> }> } }
