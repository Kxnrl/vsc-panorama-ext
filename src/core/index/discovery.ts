/**
 * Panorama 内容的发现判据。
 *
 * 两个消费方共用这一份：vscode 适配层（`workspace.findFiles` /
 * `createFileSystemWatcher`，glob 形态）与 MCP daemon（自行走文件系统，段判定
 * 形态）。判据必须同源——分叉的后果是「扩展里有跨文件能力、daemon 里没有」
 * 这种静默不一致，而且两边各自修过一次之后再也对不上。
 */

/**
 * 全量扫描与 watcher 用的 glob。供测试直接验证两种工作区形态。
 *
 * 判据落在 `layout/` 与 `styles/` 这两个真正标识 Panorama 内容的路径段上，
 * **不要求路径里出现 `panorama/` 段**——`workspace.findFiles` 匹配的是
 * 「相对工作区文件夹」的路径，**文件夹名本身不在里面**。用户把
 * `.../content/csgo/panorama`（或某个 addon 的 `panorama/`）直接开成工作区
 * 根时，相对路径形如 `20260716/styles/x.css`，一个 `panorama` 段都没有：旧的
 * `**​/panorama/**​/styles/**` 在这种形态下扫到 0 个文件、watcher 也永不触发，
 * 全部跨文件能力静默降级为空且毫无提示。把 `panorama/` 嵌在工作区里的形态
 * 相对路径是 `panorama/styles/x.css`，同样落在 `styles/` 下，一条 glob 覆盖
 * 两种形态。
 *
 * 放宽只到这一步为止：`layout/` 之外的 `.xml`、`styles/` 之外的 `.css` 仍然
 * 进不来。顺带也让索引的判据与 `panorama.customHudLayout.include` 的默认 glob
 * （`**​/layout/custom_game/**`，同样不要求 panorama 段）对齐，不再出现
 * 「严格模式生效了、索引却是空的」这种自相矛盾的状态。
 *
 * glob 只是第一道闸——它拦不住混合仓库里的 `res/layout/*.xml`、
 * `src/styles/*.css`，那些由 {@link isPanoramaContent} 这道后置过滤丢弃。
 */
export const INDEX_GLOBS = [
  '**/layout/**/*.{xml,vxml}',
  '**/styles/**/*.{css,vcss}',
] as const;

/**
 * 路径里是否有独立的 `panorama` 段。
 *
 * 按段匹配而不是按子串：`panorama-tools/` 之类的目录不该被算成 Panorama 内容根。
 * 大小写不敏感——Windows 上路径大小写不区分，Panorama 与 panorama 是同一个
 * 目录，按大小写敏感去判会把一半用户静默漏掉。
 */
export function hasPanoramaSegment(path: string): boolean {
  return /(^|\/)panorama(\/|$)/i.test(path);
}

/**
 * 后置过滤：这个文件算不算 Panorama 内容。
 *
 * {@link INDEX_GLOBS} 放宽到「`layout/` 或 `styles/` 之下」之后，混合仓库里
 * Android 的 `res/layout/*.xml`、Web 的 `src/styles/*.css` 也会命中，索引会被
 * 一堆无关类名污染——那等于把「索引恒空」这个静默失效换成「索引被污染」这个
 * 静默降级，不算真正解决。这里再要求路径里出现 `panorama` 段：
 *
 * - 根目录就是 `panorama/`（或某个 addon 的 `panorama/`）→ 工作区文件夹自身
 *   路径含 `panorama` 段 → 收下；
 * - `panorama/` 嵌在工作区里 → 文件路径含 `panorama` 段 → 收下；
 * - 混合仓库的 `res/layout/x.xml`、`src/styles/y.css` → 都不含 → 丢弃。
 *
 * 判据只看传入路径这一条，是因为调用方传入的是**绝对路径**（vscode 侧是
 * `uri.fsPath`，daemon 侧是 walk 的起点拼出来的完整路径）——工作区文件夹自身
 * 路径必然是它的前缀，两种形态在绝对路径下逐例等价（含
 * `panorama-tools/myapp/src/styles/y.css` 这种否定例）。
 *
 * 调用点必须**唯一闸口化**：首次全量扫描与增量事件都经由同一个 ingest，两条
 * 路径共用同一个判定。把它放到扫描循环里而不是 ingest 里，增量路径就会把扫描
 * 时丢弃的文件重新塞回索引——「删除被防抖静默撤销」的同型陷阱，只是方向反
 * 过来。
 */
export function isPanoramaContent(path: string): boolean {
  return hasPanoramaSegment(path.replace(/\\/g, '/'));
}

/**
 * 一条绝对路径是否该进工作区索引——{@link INDEX_GLOBS} 与
 * {@link isPanoramaContent} 合起来的段判定等价物。
 *
 * daemon 不走 glob 引擎（为两条判定链引 minimatch 不值当），用「路径段里有
 * layout/styles、且文件在其下、后缀正确、且是 Panorama 内容」四条直接判。
 * 与 glob 语义的等价性由测试钉住（等价语料见
 * test/unit/core/index/discovery.test.ts）：两边一旦漂移，同一份代码在扩展里
 * 和 daemon 里看见的工作区就不一样了。
 *
 * 细节与 glob 对齐的点：
 * - `layout` / `styles` 必须是**中间段**（文件名本身叫 layout.css 不算）；
 * - `**` 允许零段，所以 `layout/x.xml`（root 本身就是内容目录）也命中；
 * - 大小写按精确匹配——glob 引擎对段名大小写敏感，这里保持一致；
 *   `panorama` 段的宽松大小写由 {@link isPanoramaContent} 负责，不在此重复。
 */
export function isIndexCandidate(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const file = segments.pop();
  if (!file) return false;

  const underLayout = segments.includes('layout');
  const underStyles = segments.includes('styles');
  // 两种段/后缀配对**独立成立即可**：一条路径可能同时含 layout 与 styles 段
  // （/repo/layout/addon/panorama/styles/x.css 命中的是 styles 那条 glob）。
  // 写成「layout 段优先、只认 XML」会在这种路径上与 glob 语义分叉。
  const extOk =
    (underLayout && (file.endsWith('.xml') || file.endsWith('.vxml'))) ||
    (underStyles && (file.endsWith('.css') || file.endsWith('.vcss')));
  return extOk && isPanoramaContent(normalized);
}
