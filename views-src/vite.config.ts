import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { pdfAssetsPlugin } from "./pdf-assets-plugin";
import { pdfTextLayerPlugin } from "./pdf-text-layer-plugin";
import { pdfFindPlugin } from "./pdf-find-plugin";
import { pdfLifecyclePlugin } from "./pdf-lifecycle-plugin";

/**
 * 构建产物输出到插件实际加载的 ../views 目录。
 *
 * PI-Desktop 的视图以 file:// 协议加载 HTML，而 Chromium 对 file:// 下的
 * ES Module（type="module"）与 crossorigin 资源有 CORS 限制，会导致视图空白：
 *  - 产物打包为 IIFE 单文件（inlineDynamicImports——CodeMirror 6 内部有动态
 *    import()，不内联会切出独立 chunk，file:// 加载不了）
 *  - index.html 中的 <script type="module" crossorigin> 改写为普通 <script src>
 *  - <link rel="stylesheet" crossorigin> 去掉 crossorigin
 *
 * 注意：输出目录绝不能叫顶层 dist/——devkit 的 pack 会跳过它，包里就没有 JS 了。
 */
function fileProtocolCompat(): Plugin {
  return {
    name: "file-protocol-compat",
    transformIndexHtml(html) {
      return html
        .replace(
          /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
          '<script src="$1" defer></script>',
        )
        .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, '<link rel="stylesheet" href="$1">');
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), pdfAssetsPlugin(), pdfTextLayerPlugin(), pdfFindPlugin(), pdfLifecyclePlugin(), fileProtocolCompat()],
  // Keep third-party whitespace strings escaped in checked-in JavaScript.
  esbuild: { supported: { "template-literal": false } },
  build: {
    outDir: "../views",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/index.js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5175,
  },
});
