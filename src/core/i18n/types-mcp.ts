/**
 * MCP 层的文案：工具/提示模板的描述、错误信息、以及「已知清单不全」这类
 * 必须随数据一起说的免责说明。
 *
 * 工具**名**刻意不本地化（panorama_validate 等是稳定的 API 标识，agent 的
 * 记忆与用户配置都依赖它不变）；本地化的是描述、参数说明与输出里的自然语言。
 */
export interface McpMessages {
  /** panorama_validate 的工具描述 */
  toolValidateDesc(): string;
  /** panorama_panel_info 的工具描述 */
  toolPanelInfoDesc(): string;
  /** panorama_property_info 的工具描述 */
  toolPropertyInfoDesc(): string;
  /** panorama_symbols 的工具描述 */
  toolSymbolsDesc(): string;
  /** apply_fixes 的工具描述 */
  toolApplyFixesDesc(): string;
  /** workspaces 的工具描述 */
  toolWorkspacesDesc(): string;
  /** resources/panorama 数据集的描述 */
  resourceDataDesc(): string;
  /** prompt panorama_review_file 的描述 */
  promptReviewDesc(): string;
  /** prompt panorama_web_to_panorama 的描述 */
  promptWebConvertDesc(): string;
  /** prompt panorama_scaffold_layout 的描述 */
  promptScaffoldDesc(): string;
  /** validate：路径不是支持的 Panorama 文件 */
  errUnsupportedPath(path: string): string;
  /** validate / symbols：路径在磁盘上不存在 */
  errFileNotFound(path: string): string;
  /** validate / symbols：读不出来（权限等） */
  errUnreadable(path: string): string;
  /** symbols：root 不是目录 */
  errRootNotDir(root: string): string;
  /** 查询结果里「不在已知清单 ≠ 不存在」的固定说明 */
  noteDataIncomplete(): string;

  // ---- 以下为 vscode 宿主侧（mcp-host / enable 命令）的文案，daemon 不用 ----

  /** 状态栏 tooltip */
  hostStatusTooltip(url: string): string;
  /** enable 命令 QuickPick 的标题 */
  hostPickTitle(): string;
  /** QuickPick 项：写入 Claude Code 的 .mcp.json */
  hostPickClaudeCode(): string;
  /** QuickPick 项：写入 VS Code 的 .vscode/mcp.json */
  hostPickVSCode(): string;
  /** QuickPick 项：写入 Cursor 的 .cursor/mcp.json */
  hostPickCursor(): string;
  /** QuickPick 项：复制 Claude Desktop 配置片段 */
  hostPickClaudeDesktop(): string;
  /** QuickPick 项：仅复制端点 URL */
  hostPickCopyUrl(): string;
  /** 写入成功 */
  hostWroteFile(path: string): string;
  /** 复制成功 */
  hostCopied(): string;
  /** 目标配置文件已存在但不是合法 JSON——拒绝覆盖，要求人工处理 */
  hostConfigUnparsable(path: string): string;
  /** MCP 已被设置关闭 */
  hostDisabled(): string;
}
