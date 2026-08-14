// functions/lib/bookmark-export.js
// 书签导出数据查询：供手动导出与 WebDAV 备份共用

import { normalizeUrlForStorage } from './utils';
import { loadData } from './github-data-store';
import {
    normalizeBookmarkDesc,
    normalizeBookmarkLogo,
    normalizeBookmarkName,
    normalizeBookmarkUrl,
    normalizeCategoryName,
    validateImportSizes,
} from './validators';

function idKey(value) {
    return String(value ?? '');
}

function parentIdKey(value) {
    const key = idKey(value);
    return key === '' ? '0' : key;
}

/**
 * 按导入器的规则检查导出数据能否无损恢复。
 * 备份是灾难恢复的最后一道防线，不能在上传时说成功，到恢复时才跳过旧数据。
 */
export function validateBookmarkExportForImport(data) {
    if (!data || !Array.isArray(data.category) || !Array.isArray(data.sites)) {
        return { ok: false, message: '备份数据格式不正确' };
    }

    const sizeCheck = validateImportSizes(data.category, data.sites);
    if (!sizeCheck.ok) return sizeCheck;

    const categoryIds = new Set();
    const normalizedCategoryNames = new Map();
    for (const category of data.category) {
        const key = idKey(category?.id);
        if (!key || key === '0' || categoryIds.has(key)) {
            return { ok: false, message: `分类 ID 无效或重复: ${key || '(空)'}` };
        }

        const name = normalizeCategoryName(category?.catelog);
        if (!name.ok) {
            return { ok: false, message: `分类 ${key}: ${name.message}` };
        }

        categoryIds.add(key);
        normalizedCategoryNames.set(key, name.value);
    }

    // 导入器会把找不到的父级或循环层级降级到根目录，这对备份恢复属于数据丢失。
    const parentById = new Map();
    const siblingNames = new Set();
    for (const category of data.category) {
        const key = idKey(category.id);
        const parentKey = parentIdKey(category.parent_id);
        if (parentKey !== '0' && !categoryIds.has(parentKey)) {
            return { ok: false, message: `分类 ${key} 引用了不存在的父分类 ${parentKey}` };
        }
        parentById.set(key, parentKey);

        const siblingKey = `${parentKey}\u0000${normalizedCategoryNames.get(key)}`;
        if (siblingNames.has(siblingKey)) {
            return { ok: false, message: `同一父分类下存在重名分类: ${normalizedCategoryNames.get(key)}` };
        }
        siblingNames.add(siblingKey);
    }

    for (const categoryId of categoryIds) {
        const seen = new Set();
        let cursor = categoryId;
        while (cursor !== '0') {
            if (seen.has(cursor)) {
                return { ok: false, message: `分类 ${categoryId} 存在循环父级关系` };
            }
            seen.add(cursor);
            cursor = parentById.get(cursor) || '0';
        }
    }

    const normalizedUrls = new Set();
    for (let index = 0; index < data.sites.length; index++) {
        const site = data.sites[index] || {};
        const label = `第 ${index + 1} 个书签`;
        const name = normalizeBookmarkName(site.name);
        const url = normalizeBookmarkUrl(site.url);
        const logo = normalizeBookmarkLogo(site.logo);
        const desc = normalizeBookmarkDesc(site.desc, { nullIfEmpty: true });

        for (const result of [name, url, logo, desc]) {
            if (!result.ok) return { ok: false, message: `${label}: ${result.message}` };
        }

        const normalizedUrl = normalizeUrlForStorage(url.value);
        if (!normalizedUrl) {
            return { ok: false, message: `${label}: URL 必须使用 http 或 https` };
        }

        const siteCategoryId = idKey(site.catelog_id);
        if (siteCategoryId !== '0' && !categoryIds.has(siteCategoryId)) {
            return { ok: false, message: `${label}引用了不存在的分类 ${siteCategoryId || '(空)'}` };
        }

        // 与导入器的去重规则保持一致，否则恢复时会静默少一条。
        const dedupKey = normalizedUrl.endsWith('/') ? normalizedUrl.slice(0, -1) : normalizedUrl;
        if (normalizedUrls.has(dedupKey)) {
            return { ok: false, message: `${label}: URL 与其他书签重复` };
        }
        normalizedUrls.add(dedupKey);
    }

    return { ok: true };
}

/**
 * 查询可导出的分类与书签
 * @param {object} env - Cloudflare env（需要 GITHUB_REPO / NAV_AUTH 绑定）
 * @param {object} options - { includePrivate: boolean }
 * @returns {Promise<{category: Array, sites: Array}>}
 */
export async function fetchBookmarkExport(env, options = {}) {
    const includePrivate = options.includePrivate === true;

    const data = await loadData(env);
    let categories = (data.categories || []).slice();
    let sites = (data.sites || []).slice();

    if (!includePrivate) {
        // 分类私密时导入/写入逻辑会把站点一并置为私密，因此这里按 is_private 过滤即可
        categories = categories.filter(c => Number(c.is_private) === 0);
        sites = sites.filter(s => Number(s.is_private) === 0);
    }

    categories.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    sites.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(b.create_time || '').localeCompare(String(a.create_time || '')));

    return {
        category: categories,
        sites,
    };
}
