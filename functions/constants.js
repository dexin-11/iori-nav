/**
 * 项目里有 2 套不同用途的“版本机制”，不要混用：
 *
 * 1. HOME_CACHE_VERSION
 *    - 用途：首页 HTML 的 KV 缓存版本号
 *    - 何时修改：首页结构或服务端渲染结果变化，且希望强制刷新已缓存首页时
 *    - 生效方式：参与 home_html_public/home_html_private 的缓存 key 生成
 *
 * 2. 静态资源 ?v=hash
 *    - 用途：浏览器侧 CSS/JS/favicon 缓存刷新
 *    - 何时修改：无需手动修改，相关文件内容变化后自动更新
 *    - 生效方式：由 scripts/update-versions.js 计算文件哈希，并在 pre-commit 时自动写回 HTML
 */

// 首页 HTML 缓存版本 - 修改此值会强制刷新首页缓存
export const HOME_CACHE_VERSION = 'v37';

// 首页 HTML 缓存与 dirty 标记 TTL（30 天）
export const HOME_CACHE_TTL = 2592000;

// 字体映射表
export const FONT_MAP = {
  // System Fonts (无需引入)
  'sans-serif': null,
  'serif': null,
  'monospace': null,
  "'Microsoft YaHei', sans-serif": null,
  "'SimSun', serif": null,
  "'PingFang SC', sans-serif": null,
  "'Segoe UI', sans-serif": null,
  
  // Web Fonts (fonts.loli.net)
  "'Noto Sans SC', sans-serif": "https://fonts.loli.net/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap",
  "'Noto Serif SC', serif": "https://fonts.loli.net/css2?family=Noto+Serif+SC:wght@400;700&display=swap",
  "'Ma Shan Zheng', cursive": "https://fonts.loli.net/css2?family=Ma+Shan+Zheng&display=swap", // 书法
  "'ZCOOL KuaiLe', cursive": "https://fonts.loli.net/css2?family=ZCOOL+KuaiLe&display=swap", // 快乐体
  "'Long Cang', cursive": "https://fonts.loli.net/css2?family=Long+Cang&display=swap", // 草书
  "'Roboto', sans-serif": "https://fonts.loli.net/css2?family=Roboto:wght@300;400;500;700&display=swap",
  "'Open Sans', sans-serif": "https://fonts.loli.net/css2?family=Open+Sans:wght@400;600;700&display=swap",
  "'Lato', sans-serif": "https://fonts.loli.net/css2?family=Lato:wght@400;700&display=swap",
  "'Montserrat', sans-serif": "https://fonts.loli.net/css2?family=Montserrat:wght@400;700&display=swap"
};
