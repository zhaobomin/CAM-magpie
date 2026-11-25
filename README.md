# Magpie CAM

一个**纯 Magpie 插件**的上下文附件管理实现，参考并复用 Context Attachment Manager（CAM）0.13.1 的协议改写核心。

> 当前状态：已在本机 Magpie 0.1.4777 实装并通过真实网关验证；旧 Codex CAM 插件仅停用、未卸载。

## 它解决什么

原版 CAM 作为 Codex 前置代理，需要改写 Codex 的上游地址；Magpie 也管理同一地址，双方会反复接管配置。本插件把附件处理移到 Magpie 内部：

```text
Codex / Claude / 其他客户端
        │ 上游始终只指向 Magpie
        ▼
Magpie gateway
        ├─ CAM onRequest：索引附件、省略旧图、物化取图结果
        ├─ CAM tool：cam_view_image
        └─ CAM page：会话、自动管理开关、固定发送
        ▼
模型服务
```

插件不读取或修改 `~/.codex/config.toml`，不监听 Codex 配置，不创建上游代理，也不需要原版 Codex CAM 插件。

## 首版能力

- 按**用户轮次**而不是 HTTP 请求次数管理附件。
- 新图片正常发送；旧轮原图替换为带 `IMG-xxx` 的占位符。
- `cam_view_image` 按编号取回原图：
  - 本轮工具结果物化为真正的图片；
  - 同一轮重复推理仍保留；
  - 下一用户轮次再次替换为副本说明。
- 会话级自动管理开关；关闭后仍建立索引，但不省略旧图。
- 按内容哈希固定图片，固定内容不因轮次而省略。
- Responses、Chat Completions、Anthropic Messages 的历史改写与取图载荷物化。
- Gemini 请求附件索引；首版不自动省略，也不支持工具取图物化。
- Magpie 页面：原始会话标题、最近会话、缩略图、自动管理开关、固定发送。标题优先取 Codex `session_index.jsonl` 的最新名称，取不到时用首条用户消息，最后才回退到会话哈希。
- 默认只处理 `local` / `magpie-key` 请求；远程请求不建立附件索引。
- 取图载荷校验会话、图片编号、MIME 和内容 SHA-256；无效载荷不会作为 base64 文本发给模型。

## 与原版 CAM 的差异

这是可工作的首版，不声称功能完全对齐：

1. 使用 CAM 的通用请求索引，不读取 Codex rollout；因此尚未迁移原版 Codex 的特征行、逐出现位置手动勾选、fork 继承和 compaction 特化处理。
2. Magpie 的工具传输目前只返回文本。本插件先把取图结果作为受校验的临时文本载荷交给客户端，再在下一次 `onRequest` 中物化为图片。无效或无法绑定会话的载荷会被移除。
3. Magpie 工具上下文没有 `sessionID`。为避免跨会话取图，插件会在附件占位符旁写入 `[Magpie CAM session: …]`，调用 `cam_view_image` 时必须同时传回这个句柄；工具不会使用“最近会话”兜底。会话元数据、平台、图片编号和内容哈希都会再次校验。
4. Responses / Chat / Anthropic 支持取图物化；Gemini 首版只建立索引，不自动省略，也不支持工具取图物化。只有请求明确声明 CAM 工具时才省略历史原图。Codex Lite 隐藏工具名时保留原图。
5. 自动省略要求请求带有稳定会话 ID。没有 `ctx.session` 或可用 `client_metadata` 的匿名请求只建立索引，保留历史原图，不生成可取图占位符。
6. 首版处理图片，不包含原版较新的 PDF 页级取回能力。
7. Magpie 向异步 hook 提供的是已解析 JSON，而不是原始请求字节；无法保留原始 JSON 数字 token 的字节级形式。

## 数据与安全

默认数据目录：

```text
~/.config/magpie/cam
```

可通过插件选项 `dataDir` 或环境变量 `MAGPIE_CAM_DATA_DIR` 修改。目录中包含：

- `platforms/`：会话附件索引与原图 base64；
- `policies/`：自动管理和固定发送选择；
- `sessions/`：面板所需的会话元数据；
- `cache/pixels/`：像素哈希，不含图片内容。

写入采用临时文件加原子替换。面板服务仅监听 `127.0.0.1`，默认端口 `17893`。持久附件和选择状态不会写入插件目录；原生页面所需的临时 `panel/live.js` 与缩略图是重新可生成的只读视图，已加入 `.gitignore`。

## 原生与 Web 面板

Magpie 原生插件页面禁止 inline script 和网络请求，因此原生模式通过外部 `app.js` 加载 `live.js` 与静态缩略图，并使用 `magpie.options` 保存会话选择；保存或宿主重载后通过 URL hash 保持当前会话。`magpie web` 模式继续使用 17893 的本地 service API。

## 插件选项

`package.json` 给出了默认值：

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `language` | `zh` | 模型提示语言，`zh` / `en` |
| `auto` | `true` | 新会话默认启用自动管理 |
| `allowRemote` | `false` | 是否处理远程请求 |
| `gatewayTimeoutMs` | `10000` | Magpie 异步 hook 超时 |
| `maxFetchImages` | `4` | 单次最多取图数 |
| `maxFetchBytes` | `12582912` | 单次取图 base64 字符预算 |
| `panelPort` | `17893` | 面板本地服务端口 |
| `dataDir` | 上述默认目录 | 独立数据目录 |

## 验证

无需安装依赖，使用 Bun 1.4+：

```bash
bun test tests/*.test.ts
bun build src/index.ts src/hooks.ts --target bun --outdir /tmp/magpie-cam-build
```

当前验证结果：**40 tests passed，0 failed，118 assertions**，两个插件入口构建通过；另已通过真实 Magpie 网关的四轮 Responses 验证（索引 → 省略 → MCP 取图物化 → 下一轮副本省略）和原生窗口验证，详见 `docs/verification.md`。

测试覆盖：

- 旧轮省略、本轮保留、固定发送、暂停自动管理；
- 同一轮重复取图、下一轮副本省略；
- 篡改内容哈希、伪造用户消息、缺失会话和提前跳过时拒绝载荷；
- 并行会话显式句柄隔离、Codex Lite `additional_tools`、MCP hub 动态工具名、无取图工具时不省略；
- Responses / Chat / Anthropic 工具结果格式，包括 Codex 代码模式的 `input_text` 数组；
- 面板会话、策略和图片 API、跨会话访问拒绝、Host / Origin / Sec-Fetch-Site 校验。

## 安装与重载

本机已通过以下方式安装并分配给 Codex：

```bash
magpie plugin add /path/to/CAM-magpie
magpie library mcp agents CAM-magpie codex
magpie library sync
```

本地目录安装时，Magpie 可能把工具命名为 `CAM-magpie_cam_view_image`；hub 和其他安装方式还会产生不同命名空间，插件会按实际声明动态适配。修改源码后使用 `magpie plugin off <路径>` 再 `on` 重载。

**不要同时启用原版 CAM 的请求代理和本插件**。本机已用原版 CAM 的官方 `connectDirectly()` 恢复 Magpie 直连，并仅停用旧 Codex CAM 插件（未卸载）。重启 Codex 后可确保旧代理进程和旧工具完全退出。

## 目录

```text
src/hooks.ts           Magpie onRequest 适配与请求策略
src/index.ts           Magpie 主入口（仅插件与页面服务导出）
src/tool.ts            cam_view_image 取图实现
src/payload.ts         受校验的取图载荷及协议物化
src/store.ts           会话、选择策略与原子持久化
src/panel-service.ts   Web 本地页面服务
src/live-data.ts       原生页面静态 live.js 与缩略图发布
src/session-titles.ts  Codex 原始标题与首条消息回退
panel/index.html       选择面板
vendor/cam/            CAM 0.13.1 核心及许可证
tests/                 Bun 单元与端到端请求测试
```

上游许可见 [NOTICE.md](NOTICE.md) 与 [vendor/cam/LICENSE](vendor/cam/LICENSE)。
