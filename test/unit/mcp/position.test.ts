import { describe, it, expect } from 'vitest';
import { lineColAt } from '../../../src/mcp/position';

describe('lineColAt（MCP 诊断的行列换算）', () => {
  it('空文本与偏移 0 都是 1:1', () => {
    expect(lineColAt('', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColAt('abc', 0)).toEqual({ line: 1, column: 1 });
  });

  it('单行内的偏移逐列推进', () => {
    expect(lineColAt('abcdef', 3)).toEqual({ line: 1, column: 4 });
    expect(lineColAt('abcdef', 6)).toEqual({ line: 1, column: 7 });
  });

  it('换行后的偏移落在下一行', () => {
    const text = 'ab\ncd\nef';
    expect(lineColAt(text, 3)).toEqual({ line: 2, column: 1 });
    expect(lineColAt(text, 4)).toEqual({ line: 2, column: 2 });
    expect(lineColAt(text, 6)).toEqual({ line: 3, column: 1 });
  });

  it('\\r\\n 的 \\r 算行尾不算行首', () => {
    const text = 'ab\r\ncd';
    expect(lineColAt(text, 2)).toEqual({ line: 1, column: 3 });
    expect(lineColAt(text, 3)).toEqual({ line: 1, column: 4 }); // \r 仍在第 1 行
    expect(lineColAt(text, 4)).toEqual({ line: 2, column: 1 });
  });

  it('越界偏移收敛到文本末尾而不是抛异常', () => {
    expect(lineColAt('ab\ncd', 999)).toEqual({ line: 2, column: 3 });
    expect(lineColAt('ab\ncd', -5)).toEqual({ line: 1, column: 1 });
  });

  it('列按 UTF-16 码元计——代理对占两列，与编辑器缓冲区一致', () => {
    const text = '🀄x';
    expect(lineColAt(text, 2)).toEqual({ line: 1, column: 3 });
    expect(lineColAt(text, 1)).toEqual({ line: 1, column: 2 });
  });
});
