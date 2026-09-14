import { parseVxml } from '../../core/vxml/parser';
import { parseVcss } from '../../core/vcss/parser';
import { diagnoseVxml, diagnoseVcss } from '../../core/diagnostics';
import { applyFixEdits } from '../../core/fix/apply';
import { layoutModeFor } from '../../core/mode';
import { lineColAt } from '../position';
import type { McpEnv, McpServices } from '../env';
import type { WorkspaceScanner } from './symbols';
import { detectRoot, isVxmlPath, isStylesheetPath, type ValidateErr } from './validate';

export interface ApplyFixesInput {
  readonly path: string;
  readonly root?: string;
  /** 只应用这些规则的修复；缺省 = 全部可机械执行的 */
  readonly ruleIds?: readonly string[];
  /** true = 只演算不落盘，返回将要做的编辑 */
  readonly dryRun?: boolean;
}

export interface AppliedFixInfo {
  readonly ruleId: string;
  readonly line: number;
  readonly column: number;
  readonly description: string;
}

export interface ApplyFixesOk {
  readonly ok: true;
  readonly file: string;
  readonly dryRun: boolean;
  readonly applied: readonly AppliedFixInfo[];
  /** 因区间重叠整条让位的数量（详见 core/fix/apply.ts） */
  readonly skippedOverlap: number;
  /** 应用（或演算）后仍剩下的全部诊断——继续修的作业清单 */
  readonly remaining: readonly { ruleId: string; severity: string; line: number; message: string }[];
}

export type ApplyFixesResult = ApplyFixesOk | ValidateErr;

/**
 * MCP 的自动修复入口：读盘 → 诊断 → 只取**确定性**修复（Diagnostic.edits）
 * → 文本手术 → 落盘（dryRun 除外）→ 复诊返回 remaining。
 *
 * 刻意只动 edits 存在的规则：`display: flex` 该换成什么取决于作者意图，
 * 这一层永远不猜——判断型的修复属于对面的 agent（配合 panel_info /
 * property_info 自己决策），机械型的才走这里。
 */
export function applyFixes(
  input: ApplyFixesInput,
  env: McpEnv,
  services: McpServices,
  scanner?: WorkspaceScanner,
): ApplyFixesResult {
  const path = input.path.replace(/\\/g, '/');
  if (!isVxmlPath(path) && !isStylesheetPath(path)) {
    return { ok: false, error: 'unsupported-path', message: services.msg.mcp.errUnsupportedPath(path) };
  }
  if (!env.fs.exists(path)) {
    return { ok: false, error: 'file-not-found', message: services.msg.mcp.errFileNotFound(path) };
  }
  let text: string;
  try {
    text = env.fs.readFile(path);
  } catch {
    return { ok: false, error: 'unreadable', message: services.msg.mcp.errUnreadable(path) };
  }

  // 与 validate 同一条守卫：显式 root 必须是目录，typo 不允许静默变成
  // 「空但启用」的索引
  if (input.root !== undefined) {
    const given = input.root.replace(/\\/g, '/');
    if (!env.fs.isDirectory(given)) {
      return { ok: false, error: 'root-not-dir', message: services.msg.mcp.errRootNotDir(given) };
    }
  }

  const root = input.root?.replace(/\\/g, '/') ?? detectRoot(path, env);
  const index = root && scanner ? scanner.indexFor(root) : undefined;

  const diagnose = (t: string) =>
    isVxmlPath(path)
      ? diagnoseVxml(parseVxml(t), {
          uri: path, mode: layoutModeFor(path), panels: services.panels,
          observed: services.observed, index, msg: services.msg,
        })
      : diagnoseVcss(parseVcss(t), { uri: path, props: services.props, index, msg: services.msg });

  const all = diagnose(text);
  // 区分「没传」（= 全部可修的）与「传了空数组」（= 一条都不修）。
  // 写盘端点上这两种语义必须分开：[] 被当成全选会让谨慎的客户端
  // （想先看 remaining）意外改掉整个文件。
  const ruleIds = input.ruleIds;
  const selected = ruleIds === undefined ? all : all.filter((d) => ruleIds.includes(d.ruleId));

  const result = applyFixEdits(text, selected);

  if (!input.dryRun && result.applied.length > 0) {
    try {
      env.fs.writeFile(path, result.text);
    } catch {
      return { ok: false, error: 'unreadable', message: services.msg.mcp.errUnreadable(path) };
    }
  }

  const remaining = diagnose(result.text);

  return {
    ok: true,
    file: path,
    dryRun: input.dryRun === true,
    applied: result.applied.map((d) => ({
      ruleId: d.ruleId,
      ...lineColAt(text, d.start),
      description: d.fix ? d.fix.split('\n')[0] : d.message.split('\n')[0],
    })),
    skippedOverlap: result.skipped.length,
    remaining: remaining.map((d) => ({
      ruleId: d.ruleId,
      severity: d.severity,
      line: lineColAt(result.text, d.start).line,
      message: d.message.split('\n')[0],
    })),
  };
}
