import { extname } from "node:path";

const assetTypes = new Map([
    [".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"],
    [".json", "application/json"], [".map", "application/json"], [".woff2", "font/woff2"],
]);

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} path
 * @param {Uint8Array} bytes
 */
export function sendAsset(request, response, path, bytes) {
    const type = path.endsWith("/") ? "text/html" : assetTypes.get(extname(path)) ?? "text/plain";
    response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
}

/**
 * Contain HTTP request failures and retain their original causes for qualification teardown.
 * The caller owns routing, methods, provider dispatch and successful response headers.
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void | Promise<void>} handle
 * @param {unknown[]} failures
 */
export function createPackageRequestHandler(handle, failures) {
    /** @type {Set<Promise<void>>} */
    const pending = new Set();
    /** @type {import("node:http").RequestListener} */
    const listener = (request, response) => {
        /** @param {unknown} error */
        const failed = error => {
            failures.push(error);
            if (response.destroyed || response.writableEnded) return;
            if (response.headersSent) { response.destroy(); return; }
            // A failed read must not retain a successful payload's length or encoding.
            for (const name of response.getHeaderNames()) response.removeHeader(name);
            response.writeHead(500, { "Content-Length": "0" }); response.end();
        };
        const work = (async () => {
            try { await handle(request, response); }
            catch (error) { failed(error); }
        })();
        pending.add(work); void work.then(() => pending.delete(work));
    };
    return Object.freeze({ listener,
        // Stop accepting HTTP requests before awaiting handlers that outlive their responses.
        async settled() { while (pending.size) await Promise.all(pending); },
    });
}

/**
 * Acquire the ephemeral HTTP listener inside the caller's cleanup scope.
 * @param {import("node:http").Server} server
 * @param {number} [port]
 * @returns {Promise<void>}
 */
export function listenPackageServer(server, port = 0) {
    return new Promise((resolve, reject) => {
        function clear() { server.off("error", failed); server.off("listening", ready); }
        /** @param {Error} error */
        function failed(error) { clear(); reject(error); }
        function ready() { clear(); resolve(); }
        server.once("error", failed); server.once("listening", ready);
        try { server.listen(port, "127.0.0.1"); }
        catch (error) { clear(); reject(error); }
    });
}

/**
 * Also safe after a failed listen or an earlier close.
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
export function closePackageServer(server) {
    return new Promise((resolve, reject) => server.close(error => {
        if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
        else resolve();
    }));
}

/**
 * Preserve close order and attempt every owner, including after a primary failure.
 * @param {readonly (() => unknown | Promise<unknown>)[]} actions
 * @param {readonly unknown[]} [failures]
 */
export async function closePackageResources(actions, failures = []) {
    const closeErrors = [];
    for (const close of actions) {
        try { await close(); }
        catch (error) { closeErrors.push(error); }
    }
    // Request failures can be recorded while asynchronous owners are closing.
    const errors = [...failures, ...closeErrors];
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Package workload and cleanup failures.");
}
