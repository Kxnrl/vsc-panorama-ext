import { parseVxml } from '../../core/vxml/parser';
import { parseVcss } from '../../core/vcss/parser';
import { diagnoseVxml, diagnoseVcss } from '../../core/diagnostics';
import { layoutModeFor } from '../../core/mode';
import { lineColAt } from '../position';
import type { McpEnv, McpServices } from '../env';
import type { WorkspaceScanner } from './symbols';

export interface ValidateInput {
  /** 绝对路径；.xml/.vxml 走 VXML 规则，.css/.vcss 走 VCSS 规则 */
  readonly path: string;
  /**
   * 可选的工作区根。给了才跑跨文件规则（vcss.unknownDefine /
   * unknownKeyframes / vxml.unknownClass）——与 core 的语义一致：没有索引时
   * 这些规则的前提不成立，整体跳过而不是硬跑。
   * 不给时自动探测：文件祖先里最近的「其下直接有 panorama/ 目录」的根；
   * 探测不到就退单文件模式。
   */
  readonly root?: string;
}

export interface McpDiagnostic {
  readonly ruleId: string;
  readonly severity: 'error' | 'warning' | 'hint';
  readonly message: string;
  /** 具体替代写法；没有则省略 */
  readonly fix?: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface ValidateOk {
  readonly ok: true;
  readonly file: string;
  readonly language: 'panorama-vxml' | 'panorama-vcss';
  readonly mode: 'full' | 'customHudLayout';
  /** 跨文件规则是否真的跑了（root 参数给出或探测成功） */
  readonly crossFile: boolean;
  readonly diagnostics: readonly McpDiagnostic[];
}

export interface ValidateErr {
  readonly ok: false;
  readonly error: 'file-not-found' | 'unreadable' | 'unsupported-path' | 'root-not-dir';
  readonly message: string;
}

export type ValidateResult = ValidateOk | ValidateErr;

/** 与 index-host 的 isVxml 同判据：后缀即语言 */
export function isVxmlPath(path: string): boolean {
  return path.endsWith('.xml') || path.endsWith('.vxml');
}

export function isStylesheetPath(path: string): boolean {
  return path.endsWith('.css') || path.endsWith('.vcss');
}

/**
 * 从文件路径向上探测扫描根：优先「其下有 panorama/ 目录」的祖先（addon 根或
 * content 根），因为从这里往下扫，文件路径天然带 panorama 段、与
 * isIndexCandidate 的判据吻合。文件本身就在某个 panorama 目录下时（工作区根
 * 就是内容目录的形态），退而求其次用「直接含 layout/ + styles/」的那个祖先，
 * 这类根由 WorkspaceScanner 的 contentDir 模式放宽处理。
 */
export function detectRoot(path: string, env: McpEnv): string | undefined {
  let dir = path.replace(/\\/g, '/');
  const i = dir.lastIndexOf('/');
  dir = i <= 0 ? '' : dir.slice(0, i);
  for (;;) {
    if (env.fs.exists(`${dir}/panorama`)) return dir || undefined;
    if (env.fs.exists(`${dir}/layout`) && env.fs.exists(`${dir}/styles`)) return dir || undefined;
    const parent = dir.lastIndexOf('/');
    if (parent <= 0) return undefined;
    dir = dir.slice(0, parent);
  }
}

/**
 * 校验一个文件。诊断走 core 的原始输出（每条规则自带默认级别），
 * 不套 applySettings——daemon 没有用户的七档开关，那层属于 vscode 适配。
 */
export function validateFile(
  input: ValidateInput,
  env: McpEnv,
  services: McpServices,
  scanner?: WorkspaceScanner,
): ValidateResult {
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

  // 扫描根：显式 root > 自动探测 > 无（单文件）。探测本身可能很贵（逐级 exists），
  // 但都只是几次 stat，且结果交给 scanner 缓存。
  // 显式 root 必须真的是目录：typo 出来的空索引 + crossFile:true 会让
  // 所有类名背上 unknownClass 误报——空但「启用」比没有更坏。与 symbols
  // 工具同一条守卫、同一个错误码，三个入口共用一套语义。
  if (input.root !== undefined) {
    const given = input.root.replace(/\\/g, '/');
    if (!env.fs.isDirectory(given)) {
      return { ok: false, error: 'root-not-dir', message: services.msg.mcp.errRootNotDir(given) };
    }
  }
  const root = input.root?.replace(/\\/g, '/') ?? detectRoot(path, env);
  const index = root && scanner ? scanner.indexFor(root) : undefined;

  if (isVxmlPath(path)) {
    const doc = parseVxml(text);
    const diags = diagnoseVxml(doc, {
      uri: path,
      mode: layoutModeFor(path),
      panels: services.panels,
      observed: services.observed,
      index,
      msg: services.msg,
    });
    return {
      ok: true,
      file: path,
      language: 'panorama-vxml',
      mode: layoutModeFor(path),
      crossFile: index !== undefined,
      diagnostics: diags.map((d) => toMcpDiagnostic(d, text)),
    };
  }

  const doc = parseVcss(text);
  const diags = diagnoseVcss(doc, {
    uri: path,
    props: services.props,
    index,
    msg: services.msg,
  });
  return {
    ok: true,
    file: path,
    language: 'panorama-vcss',
    mode: 'full',
    crossFile: index !== undefined,
    diagnostics: diags.map((d) => toMcpDiagnostic(d, text)),
  };
}

function toMcpDiagnostic(d: { ruleId: string; severity: string; message: string; fix?: string; start: number; end: number }, text: string): McpDiagnostic {
  const start = lineColAt(text, d.start);
  const end = lineColAt(text, d.end);
  return {
    ruleId: d.ruleId,
    severity: d.severity as McpDiagnostic['severity'],
    message: d.message,
    ...(d.fix ? { fix: d.fix } : {}),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}
