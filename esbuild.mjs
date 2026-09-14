import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// 两个入口，一份公共配置：
// - extension.js   扩展宿主加载的主入口
// - mcp-daemon.cjs MCP daemon。扩展用 ELECTRON_RUN_AS_NODE spawn 它，
//   外部 MCP 客户端（Claude Code / Claude Desktop / Cursor）通过它暴露的
//   127.0.0.1 HTTP 端点访问。.cjs 后缀保证无论宿主如何解释包格式都按
//   CommonJS 运行。
const configs = [
  {
    entryPoints: ['src/vscode/extension.ts'],
    outfile: 'dist/extension.js',
  },
  {
    entryPoints: ['src/mcp/daemon.ts'],
    outfile: 'dist/mcp-daemon.cjs',
  },
];

const contexts = await Promise.all(
  configs.map((c) =>
    esbuild.context({
      ...c,
      bundle: true,
      external: ['vscode'], // vscode 由扩展宿主注入，绝不能打进包里
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      sourcemap: !production,
      minify: production,
      logLevel: 'info',
    }),
  ),
);

if (watch) {
  // 先各自显式重建一次，再进 watch。watch() 的返回不保证初次构建完成
  // （实测 marker 会抢在 [watch] build finished 之前打出来），而 F5 的
  // preLaunchTask 靠 marker 判定「产物已在盘上」——顺序错了就会带着旧
  // dist 启动。rebuild() 是等构建完成的，marker 打在它后面就稳了；
  // watch() 随后自己的初次构建只是同内容重建，晚到无妨。
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('⚡ esbuild watching (dist/extension.js + dist/mcp-daemon.cjs)');
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
