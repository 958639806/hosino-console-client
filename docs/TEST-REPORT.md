# 本次开发验证报告

日期：2026-11-03。范围为 Android 客户端与配套后端的本地验证；没有 Android 设备、staging/生产服务联调或真实 QQ 投递。

## 实际结果

| 层级 | 执行内容 | 结果与边界 |
| --- | --- | --- |
| 客户端静态检查 | TypeScript 类型检查 | 通过。 |
| 客户端单元/fixture | Vitest：连接隔离、认证、安全存储适配、请求元数据、生命周期、JSON/SSE/上传/媒体及严格 Mock | 75 项通过；Mock 不连接 OpenClaw 或 QQ。 |
| 浏览器端到端 | Playwright，手机视口 Chromium：中文附件、重复点击、响应丢失、重建后回执查询、离线、连接切换、退出及 CLI 页面 | 8 项通过；属于手机布局浏览器测试，不是 Android WebView/真机。 |
| Web 生产资源 | TypeScript + Vite build；检查生产资源中的开发 Mock 标记 | 构建通过，生产资源不包含开发 Mock 入口标记。 |
| 后端运行时与真实本地路由 | Node 测试：持久化认证、轮换/撤销、幂等冲突、并发、重启未知结果、CORS/CSRF、二进制鉴权及 CLI 记录；运行实际 HTTP 服务器并使用本地 fixture 网关/CLI | 29 项通过。验证了真实路由与本地可控执行，未验证真实远端 OpenClaw/模型 CLI。 |
| 客户端依赖检查 | `npm audit --json` | 查询时 0 项已报告漏洞；已固定 esbuild 0.28.2，并将 rimraf 的 glob 固定为 14.0.3，见锁文件。 |
| Android 原生构建 | Capacitor sync、JDK/SDK 配置及 Gradle `:app:assembleDebug` | 构建通过；`apksigner verify --verbose` 通过，APK Signature Scheme v2，开发调试签名。未安装到设备。 |

复现客户端检查：`npm ci`、`npm run check`。浏览器检查另执行 `npx playwright install chromium`、`npm run test:e2e`；测试使用显式开发 Mock。后端在配套分支执行 `npm ci`、`npm run check`、`npm test`。依赖审计为当日锁文件的数据库查询结果。

## 构建和版本

| 项目 | 记录 |
| --- | --- |
| 执行环境 | Linux 云工作区，Node.js 24.19.0，npm 11.9.0 |
| 客户端主要版本 | Capacitor 8.6.0、Vite 8.3.5、TypeScript 7.0.2；完整精确版本见 package-lock.json |
| Android 工程 | JDK 21、compile/target SDK 36、Build Tools 35.0.0、minSdk 24、最低 WebView 105、Gradle wrapper 8.14.3 |
| 配套后端 | [草稿 PR #3](https://github.com/958639806/hosino-console/pull/3)，commit `43846f7927ef82f046ed19f29989c4a8aa2d9f91` |
| 客户端 commit | 见本次提交及生成的 `artifacts/build-manifest.json`，后者记录实际完整 SHA |
| APK 路径 / SHA-256 /签名类型 | `android/app/build/outputs/apk/debug/app-debug.apk`；SHA-256 `58a1ee37862f522f61d6bc19b06d0c22ffcbd5b6b430a0e7133a01dc27c21525`；Android Debug 签名，约 4.2 MiB |

## 尚未执行

Android 安装启动、Keystore 实机持久化、Wi-Fi/蜂窝切换、锁屏与进程重建、中文输入法、软键盘、安全区/返回键、系统文件保存和分享、升级，以及授权测试服务的 HTTPS/反向代理/真实网关/CLI 联调均待验证。内部正式发布签名未配置；没有执行生产部署或生产网关重启。

A6 技术验证和 A10 内测回归尚未关闭。后续按 [Android 验证矩阵](ANDROID-VALIDATION.md) 记录设备、系统版本、步骤、结果和失败项；仅有自动测试或 APK 不代表这些场景通过。

配套后端 GitHub Actions「Mobile API」第 1 次运行已通过；本地 APK 已检查包含打包页面与 WebView 更新提示，且资源不包含开发 Mock 主机或代理路由。

客户端首轮远程 CI 暴露了登录期间能力响应重绘表单的时序问题，以及 Android 初始化默认安装已移除 tools 包的问题。现已保留未认证表单、增加迟到能力响应回归，并在 CI 显式选择 platform-tools、platforms;android-36 与 build-tools;35.0.0。
