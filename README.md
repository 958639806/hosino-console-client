# Hosino Console Android 客户端

使用 Capacitor、Vite 和 TypeScript 打包本地界面，通过 HTTPS 连接远程 [hosino-console](https://github.com/958639806/hosino-console)。OpenClaw 网关连接、服务器文件操作和 CLI 执行保留在服务端。

本轮只实现 Android。当前交付是工程与通信基础及核心页面的开发版本，不能据此认定 Issue #1 的真机验收或核心内测阶段已经完成。iOS、系统推送、后台持续连接和离线自动发送不在本轮范围内。

## 本地开发

使用 Node.js 24；依赖版本和锁文件以仓库中的 `package.json`、`package-lock.json` 为准。

```sh
npm ci
npm run dev
```

浏览器开发用于界面和 Mock 检查。浏览器环境不持久化设备凭据，不能替代 Android 安全存储、文件、生命周期和网络行为的验证。

本地 Mock 在另一个终端运行 `npm run mock`，然后访问开发地址的 `/?mock=1`，连接地址使用 `https://mock.hosino.invalid`，测试密码为 `mock-password`。只有显式开启的开发模式映射到本地 fixture 服务；生产构建没有该入口，不会替换真实服务器请求。不要在 Mock 中输入真实控制台密码。

```sh
npm run check
npm run test:e2e
npm run android:sync
```

Android 工程使用 minSdk 24、compile/target SDK 36、JDK 21 和 Gradle wrapper；设备需 WebView/Chrome 105 及以上。使用 Android Studio 打开原生工程，按 [Android 验证说明](docs/ANDROID-VALIDATION.md) 构建、安装并记录设备结果。

```sh
npm run android:open
```

构建后的 `dist/` 进入安装包；不配置远程 `server.url` 加载生产网页。开发服务器、Mock 和浏览器预览都不是生产部署。

命令行调试 APK 构建可使用 `npm run android:debug`。`npm run check` 包含类型检查、单元测试和 Web 构建；浏览器端到端测试需要先安装对应 Playwright Chromium（`npx playwright install chromium`）。

## 连接测试服务器

1. 在授权的测试服务器使用配套的 hosino-console 移动接口扩展；原始基线只有网页 Cookie 登录，不具备设备认证。
2. 提供有效 HTTPS 证书和服务器根地址，例如 `https://console.example.com`；当前连接配置不接受路径前缀、查询参数或地址内嵌密码。
3. 服务端允许 Android 本地来源 `https://localhost`。额外开发来源必须由测试服务的 `HS_MOBILE_ORIGINS` 显式允许。
4. 在客户端保存连接，先协商能力，再用现有控制台密码登录为一个设备。设备令牌进入 Android 安全存储，密码不保存。
5. CLI 在服务端默认关闭；只有明确授权的测试服务配置 `HS_MOBILE_CLI_ENABLED=1` 后才可验证，不通过页面入口推断权限。

发送超时表示结果可能未知。客户端保存原 requestId 并查询回执；重连、恢复前台和重启进程都不自动重新提交执行请求。聊天提交回执与模型运行结束是不同状态。

## 文档

- [接口契约](docs/API-CONTRACT.md)：基线接口、移动扩展、错误和回执语义。
- [实施拆分与当前状态](docs/IMPLEMENTATION.md)：A1–A10 的交付边界与依赖。
- [Android 验证](docs/ANDROID-VALIDATION.md)：可复现步骤、真机矩阵和待验证项。
- [本次测试报告](docs/TEST-REPORT.md)：实际自动测试、构建证据与未执行项。
- [安全与数据边界](docs/SECURITY.md)：凭据、连接隔离、鉴权媒体和未知结果处理。

本轮已构建并验证调试 APK 签名，尚未安装至真机或配置正式发布签名。实测和后续发布工作见验证文档；不使用历史 Mock 截图或旧仓库测试报告作为本轮验收证据。
