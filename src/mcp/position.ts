/**
 * 字符偏移 -> 1-based 行列。MCP 层自己的换算，不复用 vscode 的 positionAt
 * （daemon 进程里没有 vscode）。
 *
 * 语义对齐 vscode.TextDocument.positionAt 的**行列定义**：line 是 1 + 偏移前
 * 的换行符个数；column 是 1 + 偏移到所在行行首的 UTF-16 码元距离。列按码元
 * 数而不是显示宽度——agent 拿到坐标是为了回读文件内容做区间运算，码元偏移
 * 才是可逆的；显示宽度（制表符、代理对）在哪种定义下都不可逆。
 *
 * 换行只认 \\n：\\r\\n 里的 \\r 属于行尾不属于下一行行首，按 \\n 切与编辑器
 * 缓冲区一致。裸 \\r（Classic Mac）在 VSCode 里也会被规范化，这里不单独处理。
 */
export interface LineCol {
  readonly line: number;
  readonly column: number;
}

export function lineColAt(text: string, offset: number): LineCol {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}
