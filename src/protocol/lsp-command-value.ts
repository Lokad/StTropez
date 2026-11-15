import { jsonSnapshot } from "./json-rpc.ts";
import type { JsonValue } from "./json-rpc.ts";

export type LspCommand = Readonly<{ title: string; command: string; arguments: readonly JsonValue[] }>;

/** Decode command data only; execution and authorization belong to the captured command owner. */
export function decodeLspCommand(value: unknown): LspCommand {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Malformed LSP command.");
    const command = value as Record<string, unknown>;
    if (typeof command.title !== "string" || typeof command.command !== "string" || !command.command
        || command.arguments !== undefined && !Array.isArray(command.arguments)) throw new TypeError("Malformed LSP command.");
    return Object.freeze({ title: command.title, command: command.command, arguments: jsonSnapshot(command.arguments ?? []) as readonly JsonValue[] });
}
