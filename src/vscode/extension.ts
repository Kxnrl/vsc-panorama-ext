import type { ExtensionContext } from 'vscode';
import { createIndexHost } from './index-host';
import { createDiagnosticsHost } from './diagnostics-host';
import { registerVxml } from './providers/vxml';
import { registerVcss } from './providers/vcss';
import { registerCodeActions } from './providers/code-actions';
import { createMcpHost } from './mcp-host';

export function activate(context: ExtensionContext): void {
  const index = createIndexHost(context);
  registerVxml(context, index);
  registerVcss(context, index);
  registerCodeActions(context, index);
  createDiagnosticsHost(context, index);
  // MCP daemon 只在 mcp.enabled 时实际拉起；这里无条件注册，
  // 用户改设置后无需重载窗口
  context.subscriptions.push(createMcpHost(context));
}

export function deactivate(): void {
  // provider 与监视器均已放入 context.subscriptions，由宿主统一释放
}
