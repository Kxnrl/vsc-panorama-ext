import type { Diagnostic, FixEdit } from '../diagnostics/types';

export interface FixApplyResult {
  readonly text: string;
  /** 成功应用的诊断（按应用顺序） */
  readonly applied: readonly Diagnostic[];
  /** 因与已应用的编辑区间重叠而整条让位的诊断 */
  readonly skipped: readonly Diagnostic[];
}

/**
 * 把带 edits 的诊断应用到文本上。
 *
 * 语义：
 * - 同一条诊断的 edits 原子应用；**不同**诊断之间按首个 edit 的位置排序，
 *   区间与前面任何已接受 edit 重叠（半开区间 [s,e)，相邻不算重叠）的那条
 *   **整条让位**——半条修复比没有更糟（`hud.buttonText` 的两处 edit 少任何
 *   一处都会产出语法坏掉的标签）。
 * - 应用从后往前替换，偏移不需要滚动修正。
 *
 * core 纯函数、零 IO：文件读写由 vscode 适配层与 MCP daemon 各自完成，
 * 这里只做文本手术——与诊断管线同一套偏移语义。
 */
export function applyFixEdits(text: string, diagnostics: readonly Diagnostic[]): FixApplyResult {
  const fixable = diagnostics
    .filter((d) => d.edits !== undefined && d.edits.length > 0)
    .sort((a, b) => a.edits![0].start - b.edits![0].start);

  const applied: Diagnostic[] = [];
  const skipped: Diagnostic[] = [];
  const accepted: FixEdit[] = [];

  // 半开区间的文本重叠 + 一个补丁：**同位置的纯插入互为冲突**。[5,5) 与 [5,5)
  // 在文本重叠判定下恒不重叠（5<5 为假），于是两条诊断的插入会原地拼接——
  // 未闭合 <Button text> 的「包 Label」与「补 </Button>」同落 openEnd 时，
  // 拼出 </Button><Label… 或反之的畸形标签。插入落进别人的替换区间内
  // （[5,5) vs [3,7)）本来就由第一支判定覆盖，这里只需补同位双插入。
  const overlaps = (edit: FixEdit): boolean =>
    accepted.some(
      (a) =>
        (edit.start < a.end && a.start < edit.end) ||
        (edit.start === a.start && edit.end === a.end && edit.start === edit.end),
    );

  for (const d of fixable) {
    const edits = d.edits!;
    if (edits.some(overlaps)) {
      skipped.push(d);
      continue;
    }
    accepted.push(...edits);
    applied.push(d);
  }

  // 从后往前：先按 start 降序、同 start 按 end 降序，保证替换时
  // 前面 edit 的偏移不被后面（更靠前的）替换改变
  const ordered = [...accepted].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of ordered) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { text: out, applied, skipped };
}
