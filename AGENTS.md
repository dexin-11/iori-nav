# AGENTS.md - AI 编码助手指南

本文档为 AI 编码助手（如 Cursor、Copilot、OpenCode 等）提供项目规范和开发指南。

## 项目概述

**iori-nav（灰色轨迹）** 是一个基于 Cloudflare 全家桶构建的书签导航站点。书签数据直接以单个 JSON 文件存储在 GitHub 仓库里，不再依赖 D1 数据库。

- **语言**: JavaScript（ES6+，无 TypeScript）
- **平台**: Cloudflare Pages + Workers + KV
- **数据存储**: GitHub Contents API（书签数据存为仓库内的单个 JSON 文件）
- **前端**: HTML + TailwindCSS + 原生 JavaScript

## 目录结构

```
iori-nav/
├── functions/              # Cloudflare Pages Functions（后端）
│   ├── _middleware.js      # 全局中间件（认证、CSRF、限流、缓存失效）
│   ├── index.js            # 首页 SSR 渲染
│   ├── constants.js        # HOME_CACHE_VERSION 等核心常量
│   ├── admin/              # 管理后台（login.js, logout.js, index.js）
│   ├── api/                # REST API（categories/, config/, pending/, cache/, settings.js, wallpaper.js 等）
│   └── lib/                # 共用工具（card-renderer, menu-renderer, settings-parser, utils, wallpaper-fetcher, github-data-store）
├── public/                 # 静态资源（构建输出目录）
│   ├── index.html          # 首页 SSR 模板
│   ├── _headers            # Cloudflare Pages 响应头（静态资源长缓存配置）
│   ├── admin/index.html    # 后台管理页面
│   ├── css/                # 样式文件
│   └── js/                 # 前端脚本
├── scripts/                # 构建辅助脚本（update-versions, update-changelog）
└── wrangler.toml           # 本地开发配置（已 gitignore）
```

## 开发命令

```bash
# 安装依赖
npm install

# 构建 CSS（Tailwind）
npm run build:css

# 启动本地开发服务器
npm run dev
```

**注意**: 本项目使用少量 npm 开发依赖（如 TailwindCSS、Husky），测试使用 Node.js 内置 `node:test`，暂无 lint 工具。

**版本号自动化**: pre-commit hook 会根据 CSS/JS 文件内容自动更新 HTML 中的 `?v=` 哈希（见 `scripts/update-versions.js`），无需手动维护。

## 代码风格规范

### 命名规范

- **文件**: 小写 + 连字符（`ai-chat.js`），动态路由用方括号（`[id].js`）
- **函数**: camelCase（`isAdminAuthenticated`）
- **常量**: UPPER_SNAKE_CASE（`DATA_VERSION`）
- **布尔变量**: is/has 前缀（`isValid`、`hasChildren`）

### 文件规模与提交规范

- **新增文件行数**: 单个新增文件最好不要超过 500 行；如果实现接近或超过该规模，优先按职责拆分为多个模块。
- **提交信息**: Git commit message 使用中文，简洁描述本次改动。

### 导入规范

```javascript
import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';
```

### API 端点模式

```javascript
export async function onRequestGet(context) {
  const { request, env, params } = context;
  // ...
}

export async function onRequestPost(context) {
  const { request, env } = context;
  // ...
}
```

### 响应格式

```javascript
// 成功
return jsonResponse({ code: 200, data: results });

// 错误
return errorResponse('Unauthorized', 401);
return errorResponse(`Failed: ${e.message}`, 500);
```

### 认证检查

```javascript
if (!(await isAdminAuthenticated(request, env))) {
  return errorResponse('Unauthorized', 401);
}
```

### 安全规范

```javascript
// HTML 转义 - 防止 XSS
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// URL 清理 - 只允许 http/https
function sanitizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch { return ''; }
}
```

## 数据存储（GitHub）

项目不再使用 D1 数据库，所有数据（分类、书签、待审核、设置）都以单个 JSON 文件存在 GitHub 仓库里，通过 GitHub Contents API 读写。统一入口在 `functions/lib/github-data-store.js`。

数据结构（`emptyData()`）：

```javascript
{
  version,        // 数据版本号
  categories: [], // 分类
  sites: [],      // 书签
  pending_sites: [], // 待审核站点
  settings: [],   // 设置 [{ key, value }]
}
```

核心 API：

```javascript
import {
  readFromGithub,   // 直接读 GitHub（不过缓存），返回 { data, sha }；写操作前必须用它拿最新 SHA
  loadData,         // 读数据，优先走 KV 缓存
  saveData,         // 写回 GitHub 并刷新 KV 缓存
  nextId,           // 计算集合内下一个自增 id (max + 1)
  nowSql,           // UTC 时间串 YYYY-MM-DD HH:MM:SS
} from '../lib/github-data-store';

// 读
const data = await loadData(env);

// 写（必须先 readFromGithub 拿最新 sha，避免覆盖并发写入）
const { data, sha } = await readFromGithub(env);
data.sites.push({ id: nextId(data.sites), ... });
await saveData(env, data, sha);
```

约定：

- **读操作**用 `loadData`（走 KV 缓存，命中后不再请求 GitHub）。
- **写操作**必须先用 `readFromGithub` 拿到最新 `sha`，再修改并以 `sha` 调用 `saveData`，避免并发写入互相覆盖。
- **未配置 `GITHUB_REPO`** 时进入离线/测试模式，此时 KV 缓存是唯一数据源，`saveData` 只更新缓存，便于本地开发与单元测试。
- 数据文件默认路径 `data/data.json`，可用 `GITHUB_DATA_PATH` 覆盖。

## 前端规范

```javascript
// 使用可选链避免空引用
sidebar?.classList.add('open');

// Toast 提示
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 bg-accent-500 text-white px-4 py-2 rounded shadow-lg z-50';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `NAV_AUTH` | KV 存储绑定（会话、限流、数据缓存） | 必需 |
| `GITHUB_REPO` | 数据仓库，形如 `owner/repo` | 必需 |
| `GITHUB_DATA_PATH` | 数据文件路径 | `data/data.json` |
| `GITHUB_TOKEN` | GitHub Personal Access Token（写操作必需，作为 Secret 配置） | 空 |
| `ENABLE_PUBLIC_SUBMISSION` | 允许访客提交 | `false` |
| `SITE_NAME` | 网站名称 | `灰色轨迹` |
| `SITE_DESCRIPTION` | 首页副标题 | `一个优雅、快速、易于部署的书签（网址）收藏与分享平台，完全基于 Cloudflare 全家桶构建` |
| `FOOTER_TEXT` | 首页页脚 | `曾梦想仗剑走天涯` |
| `ICON_API` | 图标 API | `https://faviconsnap.com/api/favicon?url=` |
| `AI_REQUEST_DELAY` | AI 描述补全调用间隔（毫秒） | `1500` |

> `DISPLAY_CATEGORY` 已废弃，当前代码不会读取该变量。

## 注意事项

1. **静态资源目录**: 主要编辑 `public/` 下的文件
2. **CSS 需构建**: 修改 `public/css/tailwind.css` 后执行 `npm run build:css`
3. **SSR 渲染**: 首页通过 `functions/index.js` 服务端渲染，使用 `{{PLACEHOLDER}}` 模板替换
4. **中文支持**: 注释和用户消息可使用中文
