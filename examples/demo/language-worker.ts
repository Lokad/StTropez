import { BrowserLanguageService } from "./browser-language-service.ts";
import { createDemoLanguageSession } from "./language-session.ts";

const scope = globalThis as unknown as Pick<Worker, "postMessage" | "addEventListener">;
let started = false,
    failed = false;
let session: ReturnType<typeof createDemoLanguageSession> | undefined;
function fail(error: unknown): void {
    if (failed) return;
    failed = true;
    scope.postMessage({ error: error instanceof Error ? error.message : "Browser TypeScript failed." });
    session?.dispose();
}
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
        session?.message(event.data);
        return;
    }
    const data = event.data as { start?: boolean; names?: string[]; backing?: Record<string, string> } | null;
    if (started || !data?.start || !Array.isArray(data.names)) return;
    started = true;
    void (async () => {
        const response = await fetch(new URL("typescript-libs.json", import.meta.url));
        if (!response.ok) throw new Error("TypeScript library assets could not load.");
        const provider = new BrowserLanguageService(
            (await response.json()) as Record<string, string>,
            data.names!,
            data.backing
        );
        session = createDemoLanguageSession(
            provider,
            (ms, callback) => {
                const timer = setTimeout(callback, ms);
                return () => clearTimeout(timer);
            },
            (message) => scope.postMessage(message),
            fail
        );
        scope.postMessage({ ready: true });
    })().catch(fail);
});
