# 明明音乐 TV

Android TV 音乐应用，显示名“明明音乐”，包名 `com.aston.mingmingmusic`。Java 壳负责 TV 生命周期、动态本机端口和遥控按键；内置 Go 服务负责音乐接口、账号会话、数据同步和 Range 音频代理；WebView 负责页面、焦点和播放控件。

## 功能

- 左侧导航：歌单、搜索、榜单、播放列表、收藏、我的。
- 歌单分类筛选与详情、多个音乐来源的搜索、最近 10 个搜索关键词及手机扫码搜索。
- 歌曲列表播放、收藏/取消收藏、播放队列添加/删除及最近播放。
- 全屏和侧栏同步歌词、高亮与自动跟随；独立评论区域、头像、滚动分页和播放时评论缓慢上移。
- SVG 播放控件、进度拖动、循环模式、启动默认焦点和四方向遥控导航。
- “我的”包含登录、注册、找回密码及扫码输入；账号令牌只保存在 Go 服务中。账号数据同步失败时保留本地收藏和队列。

接口证据见 [docs/api-evidence.md](docs/api-evidence.md)，验证范围见 [docs/implementation-status.md](docs/implementation-status.md)。真实曲源可用性取决于上游服务；浏览器验证不代表实体 TV 播放已通过。

## 浏览器预览

在仓库根目录执行：

```sh
./scripts/preview.sh
```

默认访问真实上游 `https://music.lzmhhh.com`。使用 `MINGMING_PREVIEW_MODE=fixture ./scripts/preview.sh` 启动离线测试数据；服务地址由终端的 `MINGMING_MUSIC_READY` 行给出。扫码输入需要手机和运行应用的设备在同一局域网。

## 检查与 Android 编译

```sh
python3 scripts/validate_tv_app.py .
go test -race ./...
go vet ./...
npm ci --ignore-scripts
npm run check
npx playwright install chromium
npm run test:browser
```

Android 编译使用 Java 17、Gradle 8.10.2、SDK 35、NDK 27.2.12479018 和 Go 1.25。先执行 `bash scripts/build_android_binaries.sh`，再执行 `gradle -p android testDebugUnitTest lintDebug assembleDebug`。内置核心为可执行 PIE，打包到三个 ABI 的 `jniLibs` 中，由 Java 服务启动。

## 私人测试发布

源码与发布流程保存在私人仓库 `aston314/mingming-music-tv`。手动运行 GitHub Actions 的 **Build signed APK** 工作流，检查通过后使用专用签名发布正式 Release，包含版本化 APK、`update.json` 和 `SHA256SUMS.txt`。流程验证应用身份、三个 ABI、内置 UI、非调试标志和签名证书，不上传临时 Actions APK artifact。

支持 Android 6.0（API 23）及以上，包含 `arm64-v8a`、`armeabi-v7a`、`x86_64`。下载私人 Release 需有仓库权限；当前版本通过 APK 手动安装，尚未启用应用内更新。签名密钥与密码不进入 Git 仓库。
