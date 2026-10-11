# PDF 桌面回归检查

先阅读根目录 `README.md`。本检查运行 `views/` 中的生产 IIFE 和真实的 `main.js`，通过隔离的 Electron preload 桥接；窗口保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。临时目录内创建项目、Git 基线和应用 profile，结束后关闭测试进程并删除临时目录，不读取或修改真实 PI-Desktop profile。测试进程会拒绝并记录 HTTP/HTTPS 请求。

```bash
cd views-src
pnpm install --frozen-lockfile
pnpm typecheck
pnpm verify
pnpm build
cd ../tests/electron
npm install
npm run verify
```

测试依赖只供 QA 使用，不进入运行包。也可通过 `PDF_ELECTRON_DIR` 和 `PDF_PLAYWRIGHT_DIR` 指向已有、包含对应 `node_modules` 的工具目录，再运行 `node tests/electron/verify-pdf.cjs`；无需在插件中安装这些依赖。`PDF_PLUGIN_DIR` 可指向解包后的安装包，`PDF_EVIDENCE_DIR` 可指定截图目录。这两个路径应只指向用于测试的文件与输出。

覆盖实际画布与中英文文字、页导航和三种布局、缩放、缩略图、无书签提示、元数据、全文查找及计数/高亮/键盘操作、快速切换与重新加载、Git binary diff 返回、文件自动刷新、损坏和加密文档错误、窄面板双语界面、原始 PDF 字节不变，以及 Worker / Blob URL 释放。扫描件没有文字层时不提供 OCR；本测试不覆盖所有 PDF 编码、命名/嵌套书签、跨平台或超大文档性能，不能替代完整发布验收。

`fixtures/` 只含本贡献生成的小型合成文档，无聊天记录、课程材料或用户文件。`generate-fixtures.py` 给出生成过程（可选 Python 的 ReportLab 与 pypdf），常规测试直接使用已提交的夹具，无需 Python。损坏后续页的夹具由测试脚本自身生成；加密夹具密码仅用于测试，查看器应提示使用默认应用解锁。

后续修改 PDF 或 watch 行为时，应同时执行本检查，避免仅通过 Node 的纯函数测试就宣称桌面交互可用。预期损坏文档可能导致 PDF.js 控制台诊断；页面未捕获异常和任何远程请求均不应发生。
