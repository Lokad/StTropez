import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";

export function actions(controller: HostController, bindings: ViewBindings): readonly Readonly<{ label: string; invoke: () => void }>[] {
    return [
        { label: "Editor commands", invoke: bindings.openCommands },
        { label: "Insert transfer instruction", invoke: bindings.insertInstruction },
        { label: "Anchor instruction at caret", invoke: bindings.anchorInstruction },
        { label: "Close anchored instruction", invoke: controller.instruction.clear },
        { label: "Preview proposal", invoke: controller.previewProposal }, { label: "Apply proposal", invoke: controller.applyProposal },
        { label: "Save source", invoke: controller.save },
        { label: "Finish save", invoke: controller.finishSave }, { label: "Fail save", invoke: controller.failSave },
        { label: "Simulate external source change", invoke: controller.simulateExternalWrite },
        { label: "Open source review", invoke: controller.openReview }, { label: "Close source review", invoke: controller.closeReview },
        { label: "Capture reference refresh", invoke: bindings.beginReferenceRefresh }, { label: "Finish reference refresh", invoke: bindings.finishReferenceRefresh },
        { label: "Capture review acceptance", invoke: bindings.beginReviewAcceptance }, { label: "Finish review acceptance", invoke: bindings.finishReviewAcceptance },
        { label: "Run captured inputs", invoke: controller.run }, { label: "Finish run", invoke: controller.finishRun },
        { label: "Fail run", invoke: controller.failRun }, { label: "Queue setting and run", invoke: controller.demonstrateOrdering },
        { label: "Inspect recovered input", invoke: controller.inspectRecovery }, { label: "Discard recovered input", invoke: controller.discardRecovery },
        { label: "Dismiss message", invoke: controller.clearError },
        { label: "Move primary view", invoke: controller.move }, { label: "Toggle views", invoke: controller.toggleViews },
        { label: "Prompt close", invoke: controller.openClosePrompt }, { label: "Confirm close", invoke: controller.confirmClose },
        { label: "Cancel close", invoke: controller.cancelClose }, { label: "Replace primary panel", invoke: controller.replacePrimary },
        { label: "Reopen primary source", invoke: controller.reopenPrimary }, { label: "Begin delayed load", invoke: controller.beginDeferredLoad },
        { label: "Finish delayed load", invoke: controller.finishLoad }, { label: "Reopen loaded source", invoke: controller.reopenLoaded },
        { label: "Discard loaded source", invoke: controller.discardLoadedSource }, { label: "Inject form error", invoke: controller.injectFormError },
    ];
}
