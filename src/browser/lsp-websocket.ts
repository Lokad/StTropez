import type { RpcTransport } from "../protocol/json-rpc.ts";

export type WebSocketTransportOptions = Readonly<{ protocols?: string | readonly string[]; signal?: AbortSignal;
    /** Optional host text sent once after opening, before JSON-RPC can send. No acknowledgement is awaited. */
    preProtocolMessage?: string;
    openTimeoutMs?: number; maxMessageUnits?: number; maxBufferedBytes?: number; create?: (url: string, protocols?: string | string[]) => WebSocket }>;

/** Host-owned, text-message JSON-RPC framing. No socket or connection is created by importing this module. */
export function openWebSocketTransport(url: string, options: WebSocketTransportOptions = {}): Promise<RpcTransport> {
    const timeout = options.openTimeoutMs ?? 15000, maxMessage = options.maxMessageUnits ?? 4 * 1024 * 1024, maxBuffered = options.maxBufferedBytes ?? 16 * 1024 * 1024;
    if (![timeout, maxMessage, maxBuffered].every(n => Number.isSafeInteger(n) && n > 0)) return Promise.reject(new RangeError("Invalid WebSocket limits."));
    const preProtocolMessage = options.preProtocolMessage;
    if (preProtocolMessage !== undefined) {
        if (typeof preProtocolMessage !== "string") return Promise.reject(new TypeError("Pre-protocol message must be text."));
        if (preProtocolMessage.length > maxMessage || preProtocolMessage.length * 3 > maxBuffered) return Promise.reject(new RangeError("Pre-protocol message exceeds the message/buffer limit."));
    }
    if (options.signal?.aborted) return Promise.reject(new DOMException("Language connection cancelled.", "AbortError"));
    return new Promise((resolve, reject) => {
        const protocols = typeof options.protocols === "string" ? options.protocols : options.protocols && [...options.protocols];
        const socket = options.create ? options.create(url, protocols) : new WebSocket(url, protocols);
        let opening = false, opened = false, closed = false, listener: Parameters<RpcTransport["subscribe"]>[0] | undefined;
        let reason = new Error("Language connection is closed.");
        const stop = () => {
            clearTimeout(timer); socket.removeEventListener("open", open); socket.removeEventListener("message", message);
            socket.removeEventListener("error", error); socket.removeEventListener("close", close); options.signal?.removeEventListener("abort", abort);
        };
        const end = (error: Error, code = 1000) => {
            if (closed) return; closed = true; reason = error; stop();
            const active = listener; listener = undefined;
            if (!opened) reject(error); else { try { active?.close(error); } catch { /* The socket is already released. */ } }
            if (socket.readyState < 2) { try { socket.close(code, "Language transport closed"); } catch { /* Failed opening sockets may already be closing. */ } }
        };
        const send = (text: string) => {
            if (closed || socket.readyState !== 1) throw reason;
            if (text.length > maxMessage || socket.bufferedAmount + text.length * 3 > maxBuffered) {
                const error = new RangeError("Language transport exceeds its message/buffer limit."); end(error, 4009); throw error;
            }
            try { socket.send(text); } catch (error) { end(error instanceof Error ? error : new Error("Language transport send failed.")); throw reason; }
        };
        const transport: RpcTransport = Object.freeze({
            send: text => { if (!opened) throw reason; send(text); },
            subscribe: active => {
                if (listener) throw new Error("Language transport already has an owner.");
                if (closed) { active.close(reason); return () => {}; }
                listener = active; return () => { if (listener === active) listener = undefined; };
            },
            dispose: () => end(new Error("Language connection disposed.")),
        });
        const open = () => {
            if (closed || opening || opened) return; opening = true;
            try { if (preProtocolMessage !== undefined) send(preProtocolMessage); }
            catch (error) { end(error instanceof Error ? error : new Error("Language transport send failed.")); return; }
            if (closed) return; opened = true; clearTimeout(timer); resolve(transport);
        };
        const message = (event: MessageEvent<unknown>) => {
            if (closed) return;
            // Browser close() permits 1000 or application codes (3000–4999), not protocol codes 1003/1009.
            if (typeof event.data !== "string") { end(new Error("Language transport requires text messages."), 4003); return; }
            if (event.data.length > maxMessage) { end(new RangeError("Language message exceeds the configured limit."), 4009); return; }
            if (!listener) { end(new Error("Language transport received data without an owner.")); return; }
            try { listener.message(event.data); } catch (error) { end(error instanceof Error ? error : new Error("Language transport receiver failed.")); }
        };
        const error = () => end(new Error("Language WebSocket failed."));
        const close = (event: CloseEvent) => end(new Error(`Language WebSocket closed (${event.code}).`));
        const abort = () => end(new DOMException("Language connection cancelled.", "AbortError"));
        const timer = setTimeout(() => end(new Error("Language WebSocket opening timed out.")), timeout);
        socket.addEventListener("open", open); socket.addEventListener("message", message); socket.addEventListener("error", error); socket.addEventListener("close", close);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort(); else if (socket.readyState === 1) open(); else if (socket.readyState >= 2) end(reason);
    });
}
