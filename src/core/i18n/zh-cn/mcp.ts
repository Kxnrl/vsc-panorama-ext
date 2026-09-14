import type { McpMessages } from '../types-mcp';

/* 与 en/mcp.ts 逐条对应，顺序相同。 */
export const mcp: McpMessages = {
  toolValidateDesc: () =>
    '按真正的 Panorama 语言校验 CS2 布局（.xml/.vxml）或样式（.css/.vcss）文件，' +
    '返回全部诊断及具体替代写法。文件从磁盘读取；传入工作区根目录时额外执行' +
    '跨文件检查（未知类名、无法解析的 @define / @keyframes）',
  toolPanelInfoDesc: () =>
    '查询 Panorama 面板类型：基类型、能否嵌套、按继承链解析出的完整属性集。' +
    '不传面板名时列出全部 245 种已知面板',
  toolPropertyInfoDesc: () =>
    '查询 VCSS 属性、函数、at-rule 或 Web 独有写法：合法取值、Web CSS 对应写法、' +
    'Panorama 为何不同。不传名字时列出全部已知条目',
  toolSymbolsDesc: () =>
    '查询 Panorama 文件的工作区级符号：CSS 类定义与使用、id、@define 常量、' +
    '@keyframes。根目录首次扫描后有缓存；传 refresh 强制重扫',
  toolApplyFixesDesc: () =>
    '对磁盘上的 Panorama 文件应用确定性自动修复（visibility: hidden 改 collapse、' +
    '@keyframes 补引号、box-shadow 重排序、transition 简写拆分、补闭合标签、根面板 ' +
    'id 转 class、Button 文字挪进子 Label、绑定前缀置换）并复诊。只有唯一解的修复会被机械执行，' +
    '其余留给你判断；dryRun 只演算不落盘',
  toolWorkspacesDesc: () =>
    '列出当前在 VS Code 窗口中打开的 Panorama 工作区（由各窗口心跳上报）。' +
    'validate / apply_fixes / symbols 请直接使用这些根目录，不要猜。' +
    '没有任何窗口打开工作区时为空列表',
  resourceDataDesc: () =>
    '扩展背后的原始参考数据：面板注册表、VCSS 属性域、语料观察到的取值与属性，' +
    '由 CS2 自身生成的 schema 与 990 文件语料挖掘而来',
  promptReviewDesc: () =>
    '校验一个 Panorama 文件：先机械应用全部确定性修复，再逐条判断解决剩余问题，' +
    '每轮修完重新校验，直到没有可证问题为止',
  promptWebConvertDesc: () =>
    '把 Web CSS 声明转换为 Panorama 等价写法，并用属性参考解释每一处差异',
  promptScaffoldDesc: () =>
    '生成一对新的 Panorama 布局与样式文件；目标位于 layout/custom_game/ 下时' +
    '遵守 CustomHudLayout 限制',
  errUnsupportedPath: (path) => `不是 Panorama 文件（应为 .xml/.vxml 布局或 .css/.vcss 样式）：${path}`,
  errFileNotFound: (path) => `磁盘上不存在该文件：${path}`,
  errUnreadable: (path) => `文件读取失败：${path}`,
  errRootNotDir: (root) => `不是目录：${root}`,
  noteDataIncomplete: () =>
    '参考数据由 CS2 生成的 schema 加 990 文件语料人工整理而成，且已知不全——' +
    '不在清单里并不能证明该写法非法',

  hostStatusTooltip: (url) => `CS2 Panorama MCP 端点：${url}`,
  hostPickTitle: () => '要为哪个客户端启用 Panorama MCP 服务？',
  hostPickClaudeCode: () => 'Claude Code——写入本工作区 .mcp.json',
  hostPickVSCode: () => 'VS Code（Copilot Agent）——写入 .vscode/mcp.json',
  hostPickCursor: () => 'Cursor——写入 .cursor/mcp.json',
  hostPickClaudeDesktop: () => 'Claude Desktop——复制配置片段',
  hostPickCopyUrl: () => '仅复制端点 URL',
  hostWroteFile: (path) => `已更新 ${path}`,
  hostCopied: () => '已复制到剪贴板',
  hostConfigUnparsable: (path) => `${path} 已存在但不是合法 JSON——不覆盖，请手动合并该条目`,
  hostDisabled: () => 'Panorama MCP 已关闭（panorama.mcp.enabled 为 false）',
};
