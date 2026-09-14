/**
 * 共享 MCP daemon 入口。由 VS Code 扩展按需 spawn（ELECTRON_RUN_AS_NODE=1），
 * 也可以直接 `node dist/mcp-daemon.cjs` 手动起——测试与冒烟走的就是这条路。
 *
 * 生命周期约定（无 leader 架构，靠端口独占保证单例）：
 * - 端口被占（EADDRINUSE）→ 立即以 0 退出：已经有一个 daemon 在服务，
 *   第二个 spawn 天然幂等；
 * - 存活判定：/health 心跳与任何 /mcp 请求都刷新 lastActivity。全部 VS Code
 *   窗口关闭后没有心跳、也没有外部客户端（Claude Code 等）还在调用时，
 *   超过 TTL 自退——不留孤儿进程；反之一个还在工作的无头 agent 会话
 *   靠它自己的流量维持 daemon 存活；
 * - 环境变量：PANORAMA_MCP_PORT（默认 4377）、PANORAMA_MCP_LOCALE
 *   （en | zh-cn，跟随 spawn 它的 VS Code 显示语言）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, SERVER_NAME } from './server';
import { servicesFor, type McpEnv, type McpFs } from './env';
import { WorkspaceScanner } from './tools/symbols';
import { WorkspaceRegistry } from './tools/workspaces';
import pkg from '../../package.json';

const PORT = Number(process.env.PANORAMA_MCP_PORT ?? 4377);
const HOST = '127.0.0.1';

// 端口配置守卫（评审 #3）：settings.json 手改成小数/负数/越界值时，schema
// 拦不住旧版本或绕过 UI 的写法，daemon 侧再挡一道。0 是刻意放行的——
// 它是「OS 随机分配」的测试钩子（daemon.http.test.ts 靠它拿不冲突端口）。
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`panorama-mcp: 非法端口 ${process.env.PANORAMA_MCP_PORT ?? ''}（应为 0-65535 的整数）`);
  process.exit(1);
}

/**
 * 实际绑定的端口。PORT 为 0 时要等 listen 回调才知道分到了哪个，
 * 而 Host 白名单必须带上端口精确匹配（见下），所以运行时才知道的值
 * 存在这里，listen 之前一律用配置值。
 */
let boundPort = PORT;

/**
 * DNS rebinding 防护的 Host 白名单（评审 #1）。SDK 的校验是**整串精确
 * 匹配**（含端口），所以每处都要带 `host:boundPort` 形态；裸 host 形态
 * 一并放行，覆盖显式写了 80 端口以外的奇异客户端。
 */
function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return (
    host === `127.0.0.1:${boundPort}` ||
    host === `localhost:${boundPort}` ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

/**
 * Origin 哨兵（评审 #1 的纵深一层）。SDK 只在 allowedOrigins **非空**时才
 * 校验 Origin，且「没有 Origin 头」永远放行——恰好是我们要的语义：
 * 一切浏览器（必带 Origin）都被拒绝，一切非浏览器客户端（不带 Origin，
 * 包括 Claude Code / Desktop / Cursor / inspector 的 proxy）照常工作。
 * 值本身永不匹配任何真实 Origin。
 */
const ORIGIN_SENTINEL = 'panorama-daemon-denies-browsers';

/** 心跳+流量的联合 TTL。扩展侧每 10s ping 一次，90s 容得下三次丢包。 */
const ACTIVITY_TTL_MS = 90_000;
/** 单次检查间隔 */
const SWEEP_INTERVAL_MS = 15_000;
/** 请求体上限：MCP 请求都小，4MB 已是宽裕 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const locale = process.env.PANORAMA_MCP_LOCALE === 'zh-cn' ? 'zh-cn' : 'en';

/**
 * walk 的防爆闸：路径段里跳过 .git / node_modules / 隐藏目录之后，
 * 再多就是这个 root 本身给错了（比如给了 /）。50000 个条目足够任何
 * 真实 mod 仓库，包括全套反编译的 shipped UI。
 */
const MAX_WALK_ENTRIES = 50_000;

function listFiles(root: string): string[] {
  const out: string[] = [];
  const queue: string[] = [root.replace(/\/+$/, '')];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 读不了的目录当空处理——权限或并发删除都可能
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      visited++;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) queue.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

const fs: McpFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, text) => writeFileSync(p, text, 'utf8'),
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  listFiles,
};

const contentRoots = (process.env.PANORAMA_MCP_ROOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const env: McpEnv = { fs, locale, ...(contentRoots.length > 0 ? { contentRoots } : {}) };
const services = servicesFor(locale);
/** 进程级共享：scanner 的 TTL 缓存跨请求存活（见 buildMcpServer 注释） */
const scanner = new WorkspaceScanner(env);
/** 进程级共享：活跃工作区注册表，由各窗口心跳 POST /register 维护 */
const registry = new WorkspaceRegistry();

let lastActivity = Date.now();

function touch(): void {
  lastActivity = Date.now();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Streamable HTTP 的 stateless 形态：每个 POST 一个全新 transport+server。
 * Session 语义由客户端每次 initialize 重建，daemon 重启对客户端零感知——
 * 这正是「VS Code 窗口全关后自退、下次按需再起」所需要的性格。
 */
async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touch();
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
    return;
  }

  const server = buildMcpServer(env, services, scanner, registry);
  // DNS rebinding 防护（评审 #1）：apply_fixes 能改任意绝对路径，浏览器
  // rebind 到本端口即可无鉴权调用它——Host 白名单是这类攻击的标准解。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, '127.0.0.1', 'localhost'],
    allowedOrigins: [ORIGIN_SENTINEL],
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

/** /register 的异步体：读体、校验、刷新注册表（见路由处的注释） */
async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  touch();
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }
  const roots = (body as { roots?: unknown }).roots;
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((r) => typeof r !== 'string' || r.length > 4096)) {
    sendJson(res, 400, { error: 'roots must be an array of path strings (max 64)' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    server: SERVER_NAME,
    version: pkg.version,
    registered: registry.register(roots),
  });
}

const http = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];

  if (url === '/health') {
    // 健康检查虽是只读的，但 Host 守卫与 /mcp 一致：不给探测留旁门
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }
    touch();
    sendJson(res, 200, { ok: true, server: SERVER_NAME, version: pkg.version, locale });
    return;
  }

  // 受控关停（评审 #10）：扩展升级后版本错配，宿主调这里让位、再拉新版本。
  // 与 /mcp 同一道 Host 守卫——rebind 过来的浏览器不能顺手杀 daemon。
  if (url === '/shutdown') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }
    touch();
    sendJson(res, 200, { ok: true, shuttingDown: true });
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
    return;
  }

  // 工作区注册（心跳载体）：应答与 /health 同形（含 server/version），
  // 宿主一次往返同时完成活跃性、版本校验与 root 上报。与 /shutdown
  // 同一道 Host 守卫 + 同一道请求体上限。
  if (url === '/register') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }
    handleRegister(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }

  if (url !== '/mcp') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.method === 'POST') {
    handleMcpPost(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }

  // stateless：不支持 GET（SSE 常驻流）与 DELETE（会话销毁）。
  // 405 + Allow 是规范给的应答。
  res.writeHead(405, { allow: 'POST' }).end();
});

http.on('error', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    // 已有 daemon 占着端口——幂等退出，不是失败
    process.exit(0);
  }
  // 其他错误（权限等）写真退出码，让 spawn 方能看到
  console.error(`panorama-mcp: ${String(err)}`);
  process.exit(1);
});

http.listen(PORT, HOST, () => {
  // stdout 一行 JSON：spawn 方（以及人）确认起来最方便。
  // PORT=0 时上报**实际**分到的端口——测试用它拿随机端口，永不撞车
  const actual = http.address();
  boundPort = actual && typeof actual === 'object' ? actual.port : PORT;
  console.log(JSON.stringify({ panoramaMcp: true, port: boundPort, host: HOST, locale, version: pkg.version }));
});

const sweeper = setInterval(() => {
  if (Date.now() - lastActivity > ACTIVITY_TTL_MS) {
    clearInterval(sweeper);
    http.close(() => process.exit(0));
    // 还有挂着的连接时也只给 1s 宽限——闲置连接不值得为它违背 TTL 语义
    setTimeout(() => process.exit(0), 1000).unref();
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
