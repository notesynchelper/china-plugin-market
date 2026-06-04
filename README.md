# China Speedup (china-speedup)

面向中国大陆 Obsidian 用户的**加速版插件商店**。在 Obsidian 内浏览、搜索、一键安装社区插件，
插件清单与安装包都经国内中转节点（relay）加速，自动选择最快线路；无需翻墙、不再卡在
`github.com` / `raw.githubusercontent.com`。

## 功能

- **加速下载**：插件清单（`community-plugins.json` / stats / deprecation）与插件安装包
  （`main.js` / `manifest.json` / `styles.css`）都走 relay 节点的 GitHub 反向代理 + 磁盘缓存。
- **自动选最快节点**：并发探测 relay-1..5（首胜即用，localStorage 缓存 1h，失败分级清缓存），
  relay-3..5 由服务端配置预留，新增节点零客户端改动。
- **黑名单制 + 特殊导入制**：官方全量清单减去服务端黑名单；官方没有的插件可由服务端
  `marketplace-config.json` 注入「特殊导入」。两者均可热更新，无需发新版本。
- **官网调起安装**：注册 `obsidian://plugin-market-cn` 协议，官网（产品自有白名单域）可一键
  打开商店并定位/安装插件；调起安装源**只接产品自有域**，防止任意网站推送恶意安装。
- **插件自更新**：临时文件下载 → 校验 → 原子替换，主线路走 relay、回退 GitHub Release。

## 架构

```
官网(产品自有域) ──obsidian://plugin-market-cn?action=…──► 插件
真 Obsidian + 本插件
  ├ relaySelector  自动选最快 relay
  ├ registry       合并 官方清单(−黑名单) + 特殊导入
  ├ installer      BRAT 式下载→写 .obsidian/plugins/<id>/→启用
  ├ deeplink       协议 handler + 白名单 host 校验
  └ updater        自更新
        │
relay-1..5 (nginx)
  ├ /gh/raw/<path>            → raw.githubusercontent.com（缓存）
  ├ /gh/release/<repo>/<v>/<f>→ github.com/releases/download（302 改写回 relay）
  └ /plugin-market/           → marketplace-config.json + 自更新制品 + health
```

## 安装（手动）

下载 release 里的 `main.js` / `manifest.json` / `styles.css` 放到 vault 的
`.obsidian/plugins/china-speedup/`，重启 Obsidian 并在「第三方插件」里启用。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest
npm run build       # 产出 main.js
```
