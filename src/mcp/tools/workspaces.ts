/**
 * 活跃工作区注册表：把「现在有哪些 VS Code 窗口、各开着哪个仓库」从
 * 扩展宿主带进 daemon，让 MCP 对面的 agent 可以**发现**工作区，而不是
 * 只能猜根目录（拿上层目录当 root 扫，在两百个仓库的目录树里只会截断
 * 成 scanned=0——实测）。
 *
 * 生命周期沿用 daemon 的既有语义：宿主每次心跳 POST /register 刷新
 * lastSeen；超窗未刷新的 root 视为窗口已关，自动剔除。没有显式注销——
 * 窗口崩溃与正常关闭在这套语义下是同一件事，不需要区分。
 */
export const REGISTER_TTL_MS = 120_000;

export interface WorkspaceEntry {
  readonly root: string;
}

export class WorkspaceRegistry {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number = REGISTER_TTL_MS) {}

  /** 宿主心跳入口：一批 workspace folders，全量刷新 lastSeen */
  register(roots: readonly string[], now: number = Date.now()): number {
    let n = 0;
    for (const r of roots) {
      const normalized = r.replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalized.length === 0) continue;
      this.seen.set(normalized, now);
      n++;
    }
    return n;
  }

  /** 剔除超窗条目；在读路径上做，不必另起定时器 */
  private prune(now: number = Date.now()): void {
    for (const [root, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(root);
    }
  }

  list(now: number = Date.now()): readonly WorkspaceEntry[] {
    this.prune(now);
    return [...this.seen.keys()].sort().map((root) => ({ root }));
  }
}

export interface WorkspacesOk {
  readonly ok: true;
  readonly count: number;
  readonly workspaces: readonly WorkspaceEntry[];
}

/**
 * MCP `workspaces` 工具的直取实现。没有注册表实例时（如单测里直接
 * buildMcpServer 而不给 registry）返回空列表而不是报错——发现不到
 * 工作区不该阻断其它工具，agent 仍可显式传 root。
 */
export function listWorkspaces(registry: WorkspaceRegistry | undefined): WorkspacesOk {
  const workspaces = registry ? registry.list() : [];
  return { ok: true, count: workspaces.length, workspaces };
}
