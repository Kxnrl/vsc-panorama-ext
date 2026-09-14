import type { HudMessages } from './types-hud';
import type { VxmlMessages } from './types-vxml';
import type { VcssMessages } from './types-vcss';
import type { McpMessages } from './types-mcp';

/**
 * 面向用户的全部文案，按域分成四组。
 *
 * ## 为什么成员是带参数的函数，而不是模板串表
 *
 * 目的是**让漏译成为编译错误**。往接口里加一条消息，`zh-cn` 和 `en` 谁没实现
 * 谁就 tsc 报错；参数带类型，也就不存在 `{0}` 占位符对不上这种经典 i18n bug。
 *
 * 换成 `Record<string, string>` 的话，漏一个 key 只是运行时 `undefined`，
 * 而且所有测试照常全绿——静默失效的后果是**英文用户收到中文**：诊断照常出现、
 * 条数照常正确、语料闸门照常通过，只有真实用户看得见。
 *
 * 这与 `VxmlDiagCtx` 把 `panels` / `observed` 定为必填是同一条推理。
 */

/** 悬停、补全、文档符号里的通用文案。与具体诊断规则无关。 */
export interface UiMessages {
  /** 补全项 detail：该属性是 Panorama 专属 */
  panoramaOnly(): string;
  /** 悬停正文：取值列表 */
  values(list: readonly string[]): string;
  /** 悬停正文：Web 对应写法 */
  webEquivalent(s: string): string;
  /** 悬停正文：Panorama 专属属性的完整说明句 */
  panoramaOnlyNote(): string;
  /** 补全项 detail：@define 定义在当前文件，附带其取值 */
  defineInCurrentFile(value: string): string;
  /** 补全项 detail：@define 来自其它样式表 */
  defineFromOtherSheet(): string;
  /** 补全项 detail：@keyframes 来自其它样式表 */
  keyframesFromOtherSheet(): string;
  /** 补全项 detail：只在语料里见过、未经核对 */
  seenInCorpusOnly(): string;
  /** 悬停正文：@define 常量及其当前值 */
  defineHover(value: string): string;
  /** 文档符号 detail：该规则里有几条声明 */
  declarationCount(n: number): string;
  /** 补全项 detail：样式表是否已被当前布局引入 */
  stylesheetIncluded(included: boolean): string;
  /** 悬停正文：面板类型（含继承来源；基础类型传 null） */
  panelType(derivedFrom: string | null): string;
  /** 悬停正文：只能作根面板 */
  rootOnlyNote(): string;
  /** 悬停正文：是否在 CustomHudLayout 白名单内 */
  whitelistNote(allowed: boolean): string;
  /** 悬停正文：属性（含声明者；没有声明者传 undefined） */
  attributeOf(declarer: string | undefined): string;
  /** 补全项 documentation：{s:} / {d:} / {g:} / {t:} 四种绑定 */
  bindingDoc(kind: 's' | 'd' | 'g' | 't'): string;
  /** 补全项 command 的 title：触发下一段补全 */
  continueCompletion(): string;
}

export type { VcssMessages } from './types-vcss';

export type { VxmlMessages } from './types-vxml';

export type { HudMessages } from './types-hud';

export type { McpMessages } from './types-mcp';

export interface Messages {
  readonly vcss: VcssMessages;
  readonly vxml: VxmlMessages;
  readonly hud: HudMessages;
  readonly ui: UiMessages;
  readonly mcp: McpMessages;
}
