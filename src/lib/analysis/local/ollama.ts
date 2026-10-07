import http from "node:http";
import { ProviderError } from "@/lib/analysis/provider";
import { isLoopbackUrl } from "@/lib/analysis/local/config";

/**
 * A minimal Ollama client for the LOCAL provider. Plain node:http to a
 * loopback address only — there is no https and no other host: the URL is
 * re-checked on every request. node:http (not fetch) so a long CPU inference
 * isn't cut off by fetch's 5-minute header timeout; the caller's signal sets
 * the limit. Responses are size-capped and never logged.
 */

export type HttpJson = (url: string, method: "GET" | "POST", body: unknown, signal: AbortSignal, maxBytes: number) => Promise<{ status: number; json: unknown }>;

export const MAX_OLLAMA_RESPONSE_BYTES = 1_000_000;

export const loopbackJson: HttpJson = (url, method, body, signal, maxBytes) =>
  new Promise((resolve, reject) => {
    if (!isLoopbackUrl(new URL(url).origin)) return reject(new ProviderError("The local model server must be on this machine.", "rejected"));
    if (signal.aborted) return reject(new ProviderError("The request timed out.", "timeout"));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      { method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new ProviderError("The local model's answer was too large.", "invalid_response"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (size > maxBytes) return;
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return reject(new ProviderError("The local model's answer wasn't valid.", "invalid_response"));
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on("error", () => reject(new ProviderError("The local model server stopped answering.", "network")));
      }
    );
    req.on("error", () => reject(signal.aborted ? new ProviderError("The request timed out.", "timeout") : new ProviderError("The local model server couldn't be reached.", "network")));
    req.end(payload);
  });

export type ChatMessage = { role: "system" | "user"; content: string; images?: string[] };

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly request: HttpJson = loopbackJson
  ) {
    if (!isLoopbackUrl(baseUrl)) throw new ProviderError("The local model server must be on this machine.", "rejected");
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { status, json } = await this.request(`${this.baseUrl}${path}`, method, body, signal, MAX_OLLAMA_RESPONSE_BYTES);
    if (status === 404) throw new ProviderError("The local AI model isn't installed on this server.", "rejected");
    if (status >= 500) throw new ProviderError("The local model server had a problem.", "server");
    if (status !== 200) throw new ProviderError("The local model server refused the request.", "rejected");
    if (!json || typeof json !== "object") throw new ProviderError("The local model's answer wasn't valid.", "invalid_response");
    return json as Record<string, unknown>;
  }

  /** Installed models with their digests. */
  async tags(signal: AbortSignal): Promise<{ name: string; digest: string }[]> {
    const json = await this.call("GET", "/api/tags", undefined, signal);
    const models = Array.isArray(json.models) ? json.models : [];
    return models
      .filter((m): m is { name: string; digest: string } => !!m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string" && typeof (m as { digest?: unknown }).digest === "string")
      .map((m) => ({ name: m.name, digest: m.digest }));
  }

  /** A model's capabilities (e.g. "vision", "thinking"). */
  async capabilities(model: string, signal: AbortSignal): Promise<string[]> {
    const json = await this.call("POST", "/api/show", { model }, signal);
    return Array.isArray(json.capabilities) ? json.capabilities.filter((c): c is string => typeof c === "string") : [];
  }

  /**
   * One structured chat call: temperature 0, the JSON schema enforced by
   * Ollama, thinking off. Returns the answer text only (raw; the caller
   * validates it). A cut-off or empty answer is an invalid response.
   */
  async chat(
    input: { model: string; messages: ChatMessage[]; format: Record<string, unknown>; numCtx: number; numPredict: number },
    signal: AbortSignal
  ): Promise<string> {
    const json = await this.call(
      "POST",
      "/api/chat",
      {
        model: input.model,
        stream: false,
        think: false,
        format: input.format,
        keep_alive: "30m",
        options: { temperature: 0, num_ctx: input.numCtx, num_predict: input.numPredict },
        messages: input.messages,
      },
      signal
    );
    const message = json.message as { content?: unknown } | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    if (json.done_reason === "length") throw new ProviderError("The local AI's answer was cut off.", "invalid_response");
    if (!content.trim()) throw new ProviderError("The local AI gave no answer.", "invalid_response");
    return content;
  }
}
