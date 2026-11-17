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
    const errors = [...failures];
    for (const close of actions) {
        try { await close(); }
        catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Package workload and cleanup failures.");
}
