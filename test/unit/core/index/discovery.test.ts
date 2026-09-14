import { describe, it, expect } from 'vitest';
import { minimatch } from 'minimatch';
import { INDEX_GLOBS, isPanoramaContent, isIndexCandidate } from '../../../../src/core/index/discovery';

/**
 * isIndexCandidate（daemon 的段判定）必须与 vscode 侧实际使用的
 * glob 语义 + isPanoramaContent 后置过滤**逐例等价**——两边判据分叉的后果
 * 是「扩展里能查到的符号、daemon 里查不到」。这份等价语料同时咬住：
 * 正常形态、内容目录当根的形态、混合仓库的否定例、Windows 反斜杠。
 */
describe('index 判据：段判定与 glob 语义等价', () => {
  const corpus: readonly string[] = [
    // 常规形态：panorama 段 + layout/styles 段
    '/w/addons/my/panorama/layout/custom_game/x.xml',
    '/w/addons/my/panorama/layout/x.vxml',
    '/w/addons/my/panorama/styles/x.css',
    '/w/addons/my/panorama/styles/x.vcss',
    // 工作区根就是内容目录（无 panorama 段）——glob 命中但后置过滤丢弃
    '/w/panoramaRoot/20260716/layout/x.xml',
    '/w/panoramaRoot/styles/y.css',
    // 混合仓库否定例：layout/styles 段命中但没有 panorama 段
    '/w/res/layout/main.xml',
    '/w/app/src/styles/app.css',
    // panorama-tools 这种目录名不算 panorama 段
    '/w/panorama-tools/myapp/src/styles/a.css',
    '/w/panorama-tools/myapp/res/layout/b.xml',
    // panorama 段在但不在 layout/styles 之下
    '/w/addons/my/panorama/scripts/x.xml',
    '/w/addons/my/panorama/layout.xlsx',
    // 段在中段任意深度
    '/w/a/b/panorama/c/layout/d/e.xml',
    '/w/x/styles/deep/deeper/y.vcss',
    // 双段路径：命中哪条 glob 由后缀配对决定，不由「layout 段先出现」决定
    '/repo/layout/addon/panorama/styles/x.css',
    '/repo/styles/addon/panorama/layout/y.xml',
    '/repo/layout/panorama/styles/readme.txt',
    // Windows 形态
    'X:\\archive\\panorama\\layout\\x.xml',
    'X:\\archive\\res\\layout\\x.xml',
    // layout 本身作文件名（不是段）
    '/w/panorama/layout.css',
  ];

  it('语料上与 minimatch(glob) + isPanoramaContent 逐例一致', () => {
    for (const p of corpus) {
      const byGlob =
        INDEX_GLOBS.some((g) => minimatch(p.replace(/\\/g, '/'), g)) &&
        isPanoramaContent(p.replace(/\\/g, '/'));
      expect(
        isIndexCandidate(p),
        `${p}: 段判定=${isIndexCandidate(p)}，glob 判定=${byGlob}`,
      ).toBe(byGlob);
    }
  });

  it('两种工作区形态的正例都收（防止等价到一个恒假的实现）', () => {
    expect(isIndexCandidate('/w/addons/my/panorama/layout/x.xml')).toBe(true);
    expect(isIndexCandidate('/w/x/panorama/styles/y.css')).toBe(true);
  });

  it('混合仓库的否定例都丢', () => {
    expect(isIndexCandidate('/w/res/layout/main.xml')).toBe(false);
    expect(isIndexCandidate('/w/app/src/styles/app.css')).toBe(false);
  });

  it('isPanoramaContent 按段匹配且大小写不敏感', () => {
    expect(isPanoramaContent('/w/Panorama/layout/x.xml')).toBe(true);
    expect(isPanoramaContent('/w/panorama-tools/styles/x.css')).toBe(false);
    expect(isPanoramaContent('X:\\p\\Panorama\\layout\\x.xml')).toBe(true);
  });
});
