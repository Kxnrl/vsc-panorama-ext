import type { Locale } from '../core/i18n/locale';
import type { Messages } from '../core/i18n/types';
import { messagesFor } from '../core/i18n';
import { PanelRegistry } from '../core/data/panels';
import { PropertyRegistry } from '../core/data/properties';
import { ObservedAttributes } from '../core/data/observed-attributes';

/**
 * MCP 层的文件系统能力，全部**同步**谓词。
 *
 * 为什么是同步而不是 async：daemon 是单进程低并发的本地服务，同步 IO 把
 * 「扫描 + 缓存 + 查询」写成一段直线代码，不存在「缓存写入进行到一半又被读」
 * 这类时序问题；node:fs 的同步版正好逐条对应。测试注入内存实现也因此是
 * 平凡的——一个 Map 就是一片文件系统。
 *
 * 这层不属于 core：core 的边界是零 vscode / 零 node 依赖（isolation.test.ts
 * 守卫），MCP 层就是「另一条适配层」，与 src/vscode 平级，允许用 node:*；
 * 真正的 node:fs 只在 daemon 入口接进来，这里只描述形状。
 */
export interface McpFs {
  /** 抛异常表示读不到（不存在 / 无权限），文案由调用方给 */
  readonly readFile: (path: string) => string;
  /** apply_fixes 的落盘通道；抛异常表示写失败（权限等） */
  readonly writeFile: (path: string, text: string) => void;
  readonly exists: (path: string) => boolean;
  readonly isDirectory: (path: string) => boolean;
  /**
   * 列出 root 下所有文件的路径（统一 / 分隔）。
   * 跳过 node_modules / .git / 隐藏目录由实现负责，本层不再过滤——
   * 过滤规则进两份实现就会分叉。
   */
  readonly listFiles: (root: string) => readonly string[];
}

/** daemon 进程级的环境：locale 在 spawn 时定死（跟随 VS Code 显示语言）。 */
export interface McpEnv {
  readonly fs: McpFs;
  readonly locale: Locale;
  /** 对应 panorama.contentRoots，用户显式配置的内容根 */
  readonly contentRoots?: readonly string[];
}

/**
 * 三个注册表 + 消息目录：daemon 启动时按 locale 建一份，进程内共享。
 * 与 src/vscode/diagnostics-host.ts 顶层的模块级单例同理——数据只读，
 * 没有按请求重建的必要。
 */
export interface McpServices {
  readonly locale: Locale;
  readonly msg: Messages;
  readonly panels: PanelRegistry;
  readonly props: PropertyRegistry;
  readonly observed: ObservedAttributes;
}

export function servicesFor(locale: Locale): McpServices {
  return {
    locale,
    msg: messagesFor(locale),
    panels: PanelRegistry.load(locale),
    props: PropertyRegistry.load(locale),
    observed: ObservedAttributes.load(),
  };
}
