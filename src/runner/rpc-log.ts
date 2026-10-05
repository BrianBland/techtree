/** The subset of pi RPC stdout records (docs/rpc.md, json.md, rpc-extension-ui.md) the runner reads. */
export type RpcRecord = {
  type: string;
  id: string;
  method: string;
  title?: string;
  message?: string | AgentMessage;
  options?: string[];
  command?: string;
  success?: boolean;
  error?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
};

interface AgentMessage {
  role?: string;
  content?: unknown;
  errorMessage?: string;
}

export function isAssistantMessageEnd(r: RpcRecord): r is RpcRecord & { message: AgentMessage } {
  return r.type === "message_end" && typeof r.message === "object" && r.message.role === "assistant";
}

/** A one-line, human-readable description of an RPC record, or undefined for noise like streaming deltas. */
export function describeRpcRecord(r: RpcRecord): string | undefined {
  switch (r.type) {
    case "agent_start":
      return "agent started";
    case "agent_settled":
      return "agent idle";
    case "message_end":
      return isAssistantMessageEnd(r) ? `assistant: ${assistantText(r.message)}` : undefined;
    case "tool_execution_start":
      return `tool ${r.toolName} ${truncate(JSON.stringify(r.args ?? {}), 200)}`;
    case "tool_execution_end":
      return r.isError ? `tool ${r.toolName} failed` : undefined;
    case "auto_retry_start":
      return `retry ${r.attempt}/${r.maxAttempts}: ${r.errorMessage}`;
    case "compaction_start":
      return "compacting context";
    case "extension_error":
      return `extension error: ${r.error}`;
    case "response":
      return r.success === false ? `${r.command} failed: ${r.error}` : undefined;
    case "extension_ui_request":
      if (r.method === "notify") return `notify: ${r.message}`;
      if (["select", "confirm", "input", "editor"].includes(r.method))
        return `asks (${r.method}): ${[r.title, r.message, r.options?.join(" / ")].filter(Boolean).join(" — ")}`;
      return undefined;
    default:
      return undefined;
  }
}

function assistantText(message: AgentMessage): string {
  const blocks = Array.isArray(message.content) ? (message.content as { type: string; text?: string }[]) : [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return message.errorMessage ? `${text} [error: ${message.errorMessage}]`.trim() : text;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
