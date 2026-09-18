/**
 * Node.js HTTP server for the browser module.
 *
 * Serves static files (GET) and handles theme save requests (POST /save-theme).
 * Runs in-process using the built-in `http` module — no external dependencies.
 */

import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import net from "node:net";

let activeServer: Server | null = null;
let currentPort: number = 0;

// ── MIME types ─────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Port allocation ────────────────────────────────────────────────

async function findAvailablePort(): Promise<number> {
  const min = 9100;
  const max = 9199;
  for (let port = min; port <= max; port++) {
    const free = await isPortFree(port);
    if (free) return port;
  }
  throw new Error(`No available port in range ${min}-${max}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.on("error", () => resolve(false));
    tester.listen(port, "127.0.0.1", () => {
      tester.close(() => resolve(true));
    });
  });
}

// ── Request handling ───────────────────────────────────────────────

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function serveStatic(rootDir: string, urlPath: string, res: import("node:http").ServerResponse): void {
  // Default to index.html
  if (urlPath === "/") urlPath = "/index.html";

  // Prevent directory traversal
  const safePath = urlPath.replace(/\.\./g, "");
  const filePath = join(rootDir, safePath);

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}

// ── Public API ─────────────────────────────────────────────────────

export interface ServerInfo {
  port: number;
  url: string;
}

/**
 * Start a Node.js HTTP server serving files from `rootDir`.
 * Handles GET (static files) and POST /save-theme (save custom theme JSON).
 */
export async function startServer(rootDir: string): Promise<ServerInfo> {
  if (activeServer) {
    stopServer();
  }

  const customThemesDir = join(homedir(), ".swarmflow", "custom-themes");

  const port = await findAvailablePort();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const urlPath = req.url ?? "/";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // POST /save-theme
    if (method === "POST" && urlPath === "/save-theme") {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body) as { name?: string; colors?: Record<string, string> };
        const name = data.name?.trim();
        const colors = data.colors ?? {};

        if (!name) {
          sendJson(res, 400, { error: "name required" });
          return;
        }

        // Sanitize name — only alphanumeric, dash, underscore
        const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "");
        mkdirSync(customThemesDir, { recursive: true });
        const filePath = join(customThemesDir, `${safeName}.json`);
        writeFileSync(filePath, JSON.stringify({ name: safeName, colors }, null, 2), "utf-8");

        sendJson(res, 200, { ok: true, path: filePath });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // GET — serve static files
    serveStatic(rootDir, urlPath, res);
  });

  server.listen(port, "127.0.0.1");
  server.unref();

  activeServer = server;
  currentPort = port;

  // Give the server a moment to bind
  await new Promise((r) => setTimeout(r, 100));

  return { port, url: `http://127.0.0.1:${port}` };
}

/** Stop the running server. */
export function stopServer(): void {
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      // already closed
    }
    activeServer = null;
    currentPort = 0;
  }
}

/** Get the current server URL, or null if not running. */
export function getServerUrl(): string | null {
  return currentPort > 0 ? `http://127.0.0.1:${currentPort}` : null;
}
