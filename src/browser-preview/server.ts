/** 浏览器预览模块的本地 HTTP 服务器：在 localhost 提供静态文件，使用 Node 内置 `http`，无外部依赖。 */

import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import net from "node:net";

let activeServer: Server | null = null;

// ── MIME 类型 ──

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

// ── 端口分配 ──

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

// ── 请求处理 ──

function serveStatic(rootDir: string, urlPath: string, res: import("node:http").ServerResponse): void {
  // 默认返回 index.html
  if (urlPath === "/") urlPath = "/index.html";

  // 阻止目录穿越
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

// ── 对外 API ──

export interface ServerInfo {
  port: number;
  url: string;
}

/**
 * 启动 Node.js HTTP 服务器，提供 `rootDir` 下的文件。
 * 只处理 GET（静态文件）。
 */
export async function startServer(rootDir: string): Promise<ServerInfo> {
  if (activeServer) {
    stopServer();
  }

  const port = await findAvailablePort();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const urlPath = req.url ?? "/";

    // CORS 预检
    if (method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // GET — 提供静态文件
    serveStatic(rootDir, urlPath, res);
  });

  server.listen(port, "127.0.0.1");
  server.unref();

  activeServer = server;

  // 留一点时间让服务器完成绑定
  await new Promise((r) => setTimeout(r, 100));

  return { port, url: `http://127.0.0.1:${port}` };
}

/** 停止正在运行的服务器。 */
export function stopServer(): void {
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      // 已经关闭
    }
    activeServer = null;
  }
}
