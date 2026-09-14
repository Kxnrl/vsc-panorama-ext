import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import type { WorkspaceIndex } from '../../core/index/workspace-index';
import { coreDiagnosticsFor, toVscode } from '../diagnostics-host';
import type { Diagnostic as CoreDiagnostic } from '../../core/diagnostics/types';

/**
 * 灯泡 quick fix：把 core 诊断里带 edits 的那些映射成 CodeAction。
 *
 * 只有确定性修复出灯泡（edits 的准入规则见 core/diagnostics/types.ts 的
 * Diagnostic.edits 注释）——`display: flex` 换成什么没有唯一答案，那种
 * 波浪线右键应该是「没有可用操作」，而不是一个会替用户猜的按钮。
 *
 * 诊断计算与波浪线同源（coreDiagnosticsFor），同一份配置开关在这里同样
 * 生效：被 off 的规则不出现，灯泡与波浪线不会自相矛盾。
 */
class PanoramaCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] {
    // 灯泡只关心与选区**相交**的诊断；判定用偏移区间相交，行列换算全部
    // 走 doc 的 offsetAt/positionAt，不自己数
    const offsetOf = (pos: vscode.Position): number => doc.offsetAt(pos);
    const hits = coreDiagnosticsFor(doc, this.index).filter(
      (d) =>
        d.edits !== undefined &&
        d.edits.length > 0 &&
        d.start <= offsetOf(range.end) &&
        offsetOf(range.start) <= d.end,
    );

    return hits.map((d) => {
      const edit = new vscode.WorkspaceEdit();
      for (const e of d.edits!) {
        edit.replace(
          doc.uri,
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
          e.text,
        );
      }
      const action = new vscode.CodeAction(
        titleOf(d),
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = edit;
      action.diagnostics = [toVscode(doc, d)];
      action.isPreferred = true;
      return action;
    });
  }
}

/** 标题取 fix 文案首行——它本身就是本地化的「怎么改」一句话 */
function titleOf(d: CoreDiagnostic): string {
  const first = (d.fix ?? d.message).split('\n')[0].trim();
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

export function registerCodeActions(context: ExtensionContext, index: WorkspaceIndex): void {
  for (const language of ['panorama-vxml', 'panorama-vcss']) {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        { language },
        new PanoramaCodeActionProvider(index),
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
    );
  }
}
