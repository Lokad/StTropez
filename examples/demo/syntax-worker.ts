import { analyzeTypeScript } from "./syntax.ts";
import type { SyntaxOptions } from "./syntax.ts";

type Request = Readonly<{ job: number; kind: "start" | "chunk" | "finish"; text?: string; options?: SyntaxOptions }>;
let job = 0, chunks: string[] = [];
globalThis.addEventListener("message", (event: MessageEvent<Request>) => {
    const message = event.data;
    if (message.kind === "start") { job = message.job; chunks = []; return; }
    if (message.job !== job) return;
    if (message.kind === "chunk") { chunks.push(message.text ?? ""); return; }
    try {
        const result = analyzeTypeScript(chunks.join(""), message.options); chunks = [];
        globalThis.postMessage({ job, kind: "result", ...result }, { transfer: [result.spans.buffer] });
    } catch { chunks = []; globalThis.postMessage({ job, kind: "failed" }); }
});
