export type Severity = 'hint' | 'warning' | 'error';

export type SettingKey =
  | 'webOnlySyntax'
  | 'unknownProperty'
  | 'unknownClass'
  | 'unresolvedReference'
  | 'duplicateId'
  | 'structure'
  | 'customHudWhitelist';

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze([
  'webOnlySyntax',
  'unknownProperty',
  'unknownClass',
  'unresolvedReference',
  'duplicateId',
  'structure',
  'customHudWhitelist',
]);

export type RuleId =
  // 10.1 VCSS —— 能证明是错的
  | 'vcss.webOnlyProperty'
  | 'vcss.positionKeyword'
  | 'vcss.webUnit'
  | 'vcss.pseudoElement'
  | 'vcss.visibilityHidden'
  | 'vcss.customProperty'
  | 'vcss.keyframesUnquoted'
  | 'vcss.boxShadowColorFirst'
  | 'vcss.clipThenCover'
  | 'vcss.unknownDefine'
  | 'vcss.unknownKeyframes'
  // 10.2 VCSS —— 只是没见过
  | 'vcss.unknownProperty'
  | 'vcss.unknownValue'
  // 10.1 VXML
  | 'vxml.unknownTag'
  | 'vxml.rootOnlyNested'
  | 'vxml.structure'
  | 'vxml.rootPanelId'
  | 'vxml.syntax'
  // 10.2 VXML
  | 'vxml.unknownAttribute'
  | 'vxml.unknownClass'
  | 'vxml.duplicateId'
  // 10.3 CustomHudLayout 白名单
  | 'hud.panelNotAllowed'
  | 'hud.attributeNotAllowed'
  | 'hud.buttonText'
  | 'hud.scripts'
  | 'hud.inlineStyle'
  | 'hud.snippetsOrFrame'
  | 'hud.binding';

export const RULE_GROUP: Readonly<Record<RuleId, SettingKey>> = Object.freeze({
  'vcss.webOnlyProperty': 'webOnlySyntax',
  'vcss.positionKeyword': 'webOnlySyntax',
  'vcss.webUnit': 'webOnlySyntax',
  'vcss.pseudoElement': 'webOnlySyntax',
  'vcss.visibilityHidden': 'webOnlySyntax',
  'vcss.customProperty': 'webOnlySyntax',
  'vcss.keyframesUnquoted': 'webOnlySyntax',
  'vcss.boxShadowColorFirst': 'webOnlySyntax',
  'vcss.clipThenCover': 'webOnlySyntax',
  'vcss.unknownDefine': 'unresolvedReference',
  'vcss.unknownKeyframes': 'unresolvedReference',
  'vcss.unknownProperty': 'unknownProperty',
  'vcss.unknownValue': 'unknownProperty',
  'vxml.unknownTag': 'structure',
  'vxml.rootOnlyNested': 'structure',
  'vxml.structure': 'structure',
  'vxml.rootPanelId': 'structure',
  'vxml.syntax': 'structure',
  // D-M4-1：XSD 属性集被证明不完整，这条从 warning 降为 hint，归入 unknownProperty 组
  'vxml.unknownAttribute': 'unknownProperty',
  'vxml.unknownClass': 'unknownClass',
  // 规格 §10.2 与计划文档正文都把「同一文件内 id 重复」列为 hint 级，但计划文档的
  // RULE_GROUP 代码表把它塞进了 structure 组（默认 warning），与自己的正文矛盾。
  // 曾考虑并入既有的 unknownClass 组（同为 hint 默认值），裁决未采纳：配置键是
  // 用户在设置界面看到的名字，"unknownClass" 按规格只管「class 引用未定义」，
  // 塞入语义不相关的「id 重复」会让关闭一个连带关掉另一个。与 D-M4-4 同一类
  // 问题（§10.4 键位表表达不了 §10.2 要求的级别），同样的解法：拆键。
  'vxml.duplicateId': 'duplicateId',
  'hud.panelNotAllowed': 'customHudWhitelist',
  'hud.attributeNotAllowed': 'customHudWhitelist',
  'hud.buttonText': 'customHudWhitelist',
  'hud.scripts': 'customHudWhitelist',
  'hud.inlineStyle': 'customHudWhitelist',
  'hud.snippetsOrFrame': 'customHudWhitelist',
  'hud.binding': 'customHudWhitelist',
});

export const ALL_RULE_IDS: readonly RuleId[] = Object.freeze(
  Object.keys(RULE_GROUP) as RuleId[],
);

export type SettingLevel = Severity | 'off';

/**
 * **每个配置键各自允许的取值域**（规格 §10.4）。
 *
 * 三个「只是没见过」的组只开到 `warning`：`unknownProperty` 与 `unknownClass` 的
 * 数据源被证明不完整（D-M4-1：XSD 属性集实测缺 554 处；`unknownClass` 在语料上
 * 793 处命中全部是归档缺引擎样式表的症状），把它们提到 error 会让用户因为**我们
 * 的**数据缺口看到红波浪线。`duplicateId` 按同一条理由归入这三个之列（Ruling 4）。
 *
 * **这是这件事唯一的真值来源**（最终评审 M-6）。交付时它有三份互不认识的拷贝：
 * `package.json` 里逐键写的 `enum`、`test/unit/manifest.test.ts` 里逐键抄的
 * `ENUMS`、以及适配层 `readDiagnosticSettings` 里那张 `['off','hint','warning',
 * 'error']` 的**全局**表。前两份对得上，第三份对不上——手改 settings.json 写
 * `"panorama.diagnostics.unknownProperty": "error"` 会被照单接受，而设置界面的
 * 下拉框里根本没有这一项，那个键自己的描述文案也写着「最高只到 warning」。
 *
 * 现在适配层按键查这张表，`manifest.test.ts` 也拿这张表去核 `package.json`，
 * 三处收敛成一处。放在 core 而不是适配层：它是规格 §10.4 的内容，与 vscode 无关。
 */
export const ALLOWED_LEVELS: Readonly<Record<SettingKey, readonly SettingLevel[]>> = Object.freeze({
  webOnlySyntax: Object.freeze(['off', 'hint', 'warning', 'error'] as const),
  unknownProperty: Object.freeze(['off', 'hint', 'warning'] as const),
  unknownClass: Object.freeze(['off', 'hint', 'warning'] as const),
  unresolvedReference: Object.freeze(['off', 'hint', 'warning', 'error'] as const),
  duplicateId: Object.freeze(['off', 'hint', 'warning'] as const),
  structure: Object.freeze(['off', 'hint', 'warning', 'error'] as const),
  customHudWhitelist: Object.freeze(['off', 'hint', 'warning', 'error'] as const),
});

export type DiagnosticSettings = Readonly<Record<SettingKey, SettingLevel>>;

export const DEFAULT_DIAGNOSTIC_SETTINGS: DiagnosticSettings = Object.freeze({
  webOnlySyntax: 'warning',
  unknownProperty: 'hint',
  unknownClass: 'hint',
  unresolvedReference: 'warning',
  duplicateId: 'hint',
  structure: 'warning',
  customHudWhitelist: 'error',
});

export interface Diagnostic {
  readonly ruleId: RuleId;
  readonly severity: Severity;
  /** 文档绝对字符偏移；行列转换只发生在适配层 */
  readonly start: number;
  readonly end: number;
  readonly message: string;
  /** 替代写法。规格 §10.1 要求每条 warning 都给，不能只说「这个不行」 */
  readonly fix?: string;
  /**
   * 可机械执行的修复（同一处，文件绝对字符偏移，与 start/end 同一坐标系）。
   *
   * 只有**结论唯一**的修复才产出：`hidden`→`collapse`、`@keyframes` 补引号、
   * `{d:`→`{s:` 这类改法不存在第二种合理答案；而 `display: flex` 换成什么、
   * 内联 style 挪到哪个类，答案取决于作者意图——那些规则只有文字版 fix，
   * 交给灯泡里的人或 MCP 对面的 agent 判断。
   *
   * 一条诊断的一组 edits 是**原子**的：applyFixEdits 应用时要么全上、
   * 要么整条让位（与其它诊断的 edits 区间重叠时）。
   */
  readonly edits?: readonly FixEdit[];
}

/** 把 [start, end) 替换为 text。多个 edit 拼成一条修复 */
export interface FixEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
