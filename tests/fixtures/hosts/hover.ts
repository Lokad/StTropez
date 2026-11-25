import type { HoverController, HoverControllerOptions, TextEditor } from "../../../src/browser/index.ts";
import type { LspScopeAccess } from "../../../src/protocol/index.ts";

type Settings = { delay: number; fault?: "malformed" | "failure" | "markup" };
type Session = { editor: TextEditor; controller: HoverController; settings: Settings };
export type HoverHostOptions = Readonly<{
    beforeRequest?: (session: LspScopeAccess, config: Settings) => Promise<unknown>;
    canCapture?: (document: TextEditor["view"]["documentId"]) => boolean;
}>;

/** Routes fixture requests to a named pane and reports its observable result. */
export class HostHoverTools {
    private readonly sessions = new Map<string, Session>();
    private current?: Session;
    private readonly retired = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    private readonly allowInspect: (kind: "pointer" | "keyboard") => boolean;
    private readonly options: HoverHostOptions;
    constructor(allowInspect: (kind: "pointer" | "keyboard") => boolean, options: HoverHostOptions) {
        this.allowInspect = allowInspect;
        this.options = options;
    }

    readonly dismiss = () => {
        this.current?.controller.cancel();
        delete this.current;
    };
    inspectCaret(id: string): boolean {
        return this.sessions.get(id)?.editor.commands.run("hover.inspect") ?? false;
    }
    controllerOptions(editor: TextEditor, settings: Settings): HoverControllerOptions {
        const { beforeRequest, canCapture } = this.options;
        return {
            canCapture: () => canCapture?.(editor.view.documentId) ?? true,
            popup: { beforeInspect: kind => {
                if (!this.allowInspect(kind)) return false;
                const session = [...this.sessions.values()].find(item => item.editor === editor);
                if (!session) return false;
                if (session !== this.current) this.dismiss();
                this.current = session;
                return true;
            } },
            ...(beforeRequest && { prepareRequest: access => {
                const config = { ...settings };
                delete settings.fault;
                return beforeRequest(access, config);
            } }),
        };
    }
    bind(id: string, editor: TextEditor, controller: HoverController, settings: Settings): () => void {
        const session = { editor, controller, settings };
        this.sessions.set(id, session);
        return () => {
            if (this.sessions.get(id) !== session) return;
            this.sessions.delete(id);
            if (this.current === session) delete this.current;
            const counts = controller.getDiagnostics();
            for (const name of Object.keys(this.retired) as (keyof typeof this.retired)[]) this.retired[name] += counts[name];
        };
    }
    setDelay(id: string, value: number): void {
        if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid hover delay.");
        const session = this.sessions.get(id);
        if (session) session.settings.delay = value;
    }
    faultNext(id: string, value: NonNullable<Settings["fault"]>): void {
        const session = this.sessions.get(id);
        if (session) session.settings.fault = value;
    }
    debug() {
        const active = [...this.sessions].find(([, session]) => session === this.current);
        const state = this.current?.controller.getSnapshot();
        return {
            presentation: { status: state?.status ?? "idle", visible: !!this.current?.editor.element.querySelector(".st-hover:not([hidden])"),
                view: active?.[0] ?? null, text: state?.text ?? "", message: state?.message ?? "", ...(state?.content && { content: state.content }) },
            sessions: [...this.sessions].map(([id, session]) => ({ id, viewId: session.editor.view.id,
                counters: { ...session.controller.getDiagnostics(), transport: "lsp3.17" } })), retired: { ...this.retired },
        };
    }
}
