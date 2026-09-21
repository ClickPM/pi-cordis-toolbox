import type { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import type { OperationContext, OperationResult } from "../../src/core/types.ts";

function isPrivateIp(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }

  // IPv4 regex check
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link Local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true;
  }

  return false;
}

function validateUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL format: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are allowed.`);
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new Error(`SSRF blocked: accessing private or local network address "${parsed.hostname}" is forbidden.`);
  }

  return parsed;
}

function htmlToMarkdown(html: string): string {
  // 1. Strip script, style, noscript, svg, nav, footer, header tags
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "");

  // 2. Headings
  cleaned = cleaned.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  cleaned = cleaned.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  cleaned = cleaned.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  cleaned = cleaned.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  cleaned = cleaned.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  cleaned = cleaned.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // 3. Links
  cleaned = cleaned.replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // 4. Code and pre
  cleaned = cleaned.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  cleaned = cleaned.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // 5. Lists and paragraphs
  cleaned = cleaned.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  cleaned = cleaned.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");

  // 6. Strip all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // 7. Unescape basic HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // 8. Collapse whitespace and redundant empty lines
  const lines = cleaned.split("\n").map((line) => line.trim());
  const deduped: string[] = [];
  let emptyCount = 0;
  for (const line of lines) {
    if (!line) {
      emptyCount++;
      if (emptyCount <= 2) deduped.push("");
    } else {
      emptyCount = 0;
      deduped.push(line);
    }
  }

  return deduped.join("\n").trim();
}

export default function webFetchPlugin(ctx: Context): void {
  ctx.toolbox.registerOperation({
    name: "web.fetch",
    label: "Fetch Web Page",
    description:
      "Fetch webpage content via HTTP/HTTPS with SSRF guards and format as clean Markdown or text.",
    risk: "network",
    parameters: Type.Object({
      url: Type.String({
        minLength: 5,
        description: "Public HTTP or HTTPS URL to fetch.",
      }),
      format: Type.Optional(
        Type.Union(
          [
            Type.Literal("markdown"),
            Type.Literal("text"),
            Type.Literal("html"),
            Type.Literal("json"),
          ],
          {
            description: "Format of output content. Defaults to 'markdown'.",
          },
        ),
      ),
      maxBytes: Type.Optional(
        Type.Integer({
          minimum: 1024,
          maximum: 1024 * 1024 * 5,
          description: "Max bytes to read from response. Defaults to 102400 (100KB).",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          maximum: 60000,
          description: "Request timeout in milliseconds. Defaults to 15000.",
        }),
      ),
    }),
    execute: async (params, operationContext: OperationContext): Promise<OperationResult> => {
      const input = params as {
        url: string;
        format?: "markdown" | "text" | "html" | "json";
        maxBytes?: number;
        timeoutMs?: number;
      };

      const parsedUrl = validateUrl(input.url);
      const timeoutMs = input.timeoutMs ?? 15000;
      const maxBytes = input.maxBytes ?? 100 * 1024;
      const format = input.format ?? "markdown";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      const combinedSignal = AbortSignal.any([operationContext.signal, controller.signal]);

      try {
        const response = await fetch(parsedUrl.toString(), {
          signal: combinedSignal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; PiCordisToolbox/0.3; +https://github.com/ClickPM/pi-cordis-toolbox)",
            Accept:
              format === "json"
                ? "application/json, text/plain, */*"
                : "text/html, text/markdown, text/plain;q=0.9, */*;q=0.8",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP fetch failed with status ${response.status} ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const sliced = buffer.byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer;
        const text = new TextDecoder("utf-8").decode(sliced);

        let content = text;
        if (format === "markdown") {
          content = htmlToMarkdown(text);
        } else if (format === "text") {
          content = htmlToMarkdown(text).replace(/\[(.*?)\]\(.*?\)/g, "$1");
        } else if (format === "json") {
          try {
            content = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            // Keep raw if not valid json
          }
        }

        return {
          content,
          details: {
            url: parsedUrl.toString(),
            status: response.status,
            bytesReceived: buffer.byteLength,
            truncated: buffer.byteLength > maxBytes,
            format,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

webFetchPlugin.inject = ["toolbox"];
