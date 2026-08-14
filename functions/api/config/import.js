// functions/api/config/import.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { getUrlMatchCandidates, normalizeUrlForStorage } from '../../lib/utils';
import {
    normalizeBookmarkDesc,
    normalizeBookmarkLogo,
    normalizeBookmarkName,
    normalizeBookmarkUrl,
    normalizeCategoryName,
    IMPORT_BODY_MAX_BYTES,
    IMPORT_BODY_MAX_MB,
    validateImportSizes,
} from '../../lib/validators';
import { readFromGithub, saveData, nextId, nowSql } from '../../lib/github-data-store';

function getImportIdKey(value) {
    return String(value ?? '');
}

function getImportParentIdKey(value) {
    const key = getImportIdKey(value);
    return key === '' ? '0' : key;
}

/**
 * 返回 categoryId 及其全部后代分类的 id 集合
 */
function getDescendantIds(categories, rootId) {
    const result = [];
    const stack = [String(rootId)];
    while (stack.length > 0) {
        const id = stack.pop();
        result.push(id);
        for (const c of categories) {
            if (String(c.parent_id) === String(id)) stack.push(String(c.id));
        }
    }
    return result;
}

const ROOT_IMPORT_CATEGORY_NAME = '默认';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    // 限制请求体大小
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > IMPORT_BODY_MAX_BYTES) {
      return errorResponse(`请求体过大，最大允许 ${IMPORT_BODY_MAX_MB}MB`, 413);
    }

    const jsonData = await request.json();
    let categoriesToImport = [];
    let sitesToImport = [];
    let isNewFormat = false;
    // 获取 override 参数，默认 false
    const override = !!jsonData.override;

    // Detect import format
    // Handle the wrapper payload if it exists (due to frontend change passing { ...data, override })
    let payload = jsonData;
    if (jsonData.category && jsonData.sites && (jsonData.override !== undefined || Object.keys(jsonData).length > 2)) {
         // It's the new payload wrapper
         payload = jsonData;
    } else if (jsonData.category && jsonData.sites) {
        // Direct export format
        payload = jsonData;
    }

    if (payload && typeof payload === 'object' && Array.isArray(payload.category) && Array.isArray(payload.sites)) {
      categoriesToImport = payload.category;
      sitesToImport = payload.sites;
      isNewFormat = true;
    } else if (Array.isArray(jsonData)) { // Legacy format support (raw array)
      sitesToImport = jsonData;
    } else {
      return errorResponse('Invalid JSON format. Expected { "category": [...], "sites": [...] } or an array of sites.', 400);
    }

    const importSizeCheck = validateImportSizes(categoriesToImport, sitesToImport);
    if (!importSizeCheck.ok) {
      return errorResponse(importSizeCheck.message, 400);
    }

    if (sitesToImport.length === 0 && categoriesToImport.length === 0) {
      return jsonResponse({ code: 200, message: 'Import successful, but no sites were found to import.' });
    }

    const { data, sha } = await readFromGithub(env);
    const existingDbCategories = data.categories || [];
    let didMutate = false;

    // --- Category Processing ---
    const oldCatIdToNewCatIdMap = new Map(); // Maps JSON ID -> New ID
    const privateCategoryIdsToPropagate = new Set();
    const normalizedImportCategoryNames = new Map();
    let categoryNameToIdMap = new Map(); // For legacy format mapping
    
    // Helper to find existing category by name and parent_id
    const findExistingCategory = (name, parentId) => {
        const normalizedParentId = (parentId === null || parentId === undefined) ? 0 : parseInt(parentId, 10);
        return existingDbCategories.find(c => {
            const dbParentId = (c.parent_id === null || c.parent_id === undefined) ? 0 : parseInt(c.parent_id, 10);
            return c.catelog === name && dbParentId === normalizedParentId;
        });
    };

    if (isNewFormat) {
        // Validate all categories first
        for (const cat of categoriesToImport) {
            const categoryNameResult = normalizeCategoryName(cat.catelog);
            if (!categoryNameResult.ok) {
                return errorResponse(`导入失败：${categoryNameResult.message}`, 400);
            }
            normalizedImportCategoryNames.set(cat, categoryNameResult.value);
        }

        // Sort categories to ensure parents are processed before children (Topological Sort)
        let sortedCats = [];
        let remaining = [...categoriesToImport];
        let processedJsonIds = new Set(['0']);
        
        let lastRemainingCount = -1;
        while(remaining.length > 0) {
            if (remaining.length === lastRemainingCount) {
                sortedCats.push(...remaining);
                break;
            }
            lastRemainingCount = remaining.length;
            
            const [ready, notReady] = remaining.reduce((acc, cat) => {
                const pid = getImportParentIdKey(cat.parent_id);
                if (processedJsonIds.has(pid)) {
                    acc[0].push(cat);
                } else {
                    acc[1].push(cat);
                }
                return acc;
            }, [[], []]);
            
            ready.sort((a, b) => (a.id || 0) - (b.id || 0));
            ready.forEach(cat => processedJsonIds.add(getImportIdKey(cat.id)));
            sortedCats.push(...ready);
            remaining = notReady;
        }
        categoriesToImport = sortedCats;

        for (const cat of categoriesToImport) {
            const catName = normalizedImportCategoryNames.get(cat);
            const jsonParentIdKey = getImportParentIdKey(cat.parent_id);
            const importedIsPrivate = cat.is_private ? 1 : 0; // Import privacy setting
            
            let dbParentId = 0;
            if (jsonParentIdKey !== '0') {
                dbParentId = oldCatIdToNewCatIdMap.has(jsonParentIdKey)
                    ? oldCatIdToNewCatIdMap.get(jsonParentIdKey)
                    : 0;
            }

            const parentCategory = dbParentId
                ? existingDbCategories.find(c => String(c.id) === String(dbParentId))
                : null;
            const isPrivate = parentCategory?.is_private === 1 ? 1 : importedIsPrivate;
            const existing = findExistingCategory(catName, dbParentId);
            
            if (existing) {
                if (isPrivate === 1 && existing.is_private !== 1) {
                    existing.is_private = 1;
                    privateCategoryIdsToPropagate.add(existing.id);
                    didMutate = true;
                }
                oldCatIdToNewCatIdMap.set(getImportIdKey(cat.id), existing.id);
            } else {
                const sortOrder = normalizeSortOrder(cat.sort_order);
                const newId = nextId(existingDbCategories);
                const now = nowSql();
                const newCatObj = {
                    id: newId,
                    catelog: catName,
                    sort_order: sortOrder,
                    parent_id: dbParentId,
                    is_private: isPrivate,
                    create_time: now,
                    update_time: now,
                };
                existingDbCategories.push(newCatObj);
                didMutate = true;
                
                oldCatIdToNewCatIdMap.set(getImportIdKey(cat.id), newId);
            }
        }

        if (privateCategoryIdsToPropagate.size > 0) {
            for (const rootId of privateCategoryIdsToPropagate) {
                const ids = new Set(getDescendantIds(existingDbCategories, rootId));
                existingDbCategories.forEach(c => { if (ids.has(String(c.id))) c.is_private = 1; });
                (data.sites || []).forEach(s => { if (ids.has(String(s.catelog_id))) s.is_private = 1; });
            }
        }

        const hasRootSites = sitesToImport.some(site => getImportIdKey(site.catelog_id) === '0');
        if (hasRootSites) {
            const rootCategoryNameResult = normalizeCategoryName(ROOT_IMPORT_CATEGORY_NAME);
            if (!rootCategoryNameResult.ok) {
                return errorResponse(`导入失败：${rootCategoryNameResult.message}`, 400);
            }

            const rootCategoryName = rootCategoryNameResult.value;
            const existingRootCategory = findExistingCategory(rootCategoryName, 0);

            if (existingRootCategory) {
                oldCatIdToNewCatIdMap.set('0', existingRootCategory.id);
            } else {
                const now = nowSql();
                const newRootCategoryId = nextId(existingDbCategories);
                existingDbCategories.push({
                    id: newRootCategoryId,
                    catelog: rootCategoryName,
                    sort_order: 9999,
                    parent_id: 0,
                    is_private: 0,
                    create_time: now,
                    update_time: now,
                });
                oldCatIdToNewCatIdMap.set('0', newRootCategoryId);
                didMutate = true;
            }
        }
    } else {
        existingDbCategories.forEach(c => categoryNameToIdMap.set(c.catelog, c.id));
        const defaultCategory = 'Default';
        const categoryNames = [...new Set(sitesToImport.map(item => {
            const categoryNameResult = normalizeCategoryName(item.catelog || defaultCategory);
            return categoryNameResult.ok ? categoryNameResult.value : '';
        }))].filter(name => name);
        const newCategoryNames = categoryNames.filter(name => !categoryNameToIdMap.has(name));

        if (newCategoryNames.length > 0) {
            // Legacy import doesn't have is_private info, defaults to 0
            const now = nowSql();
            newCategoryNames.forEach(name => {
                const newId = nextId(existingDbCategories);
                existingDbCategories.push({
                    id: newId,
                    catelog: name,
                    sort_order: 9999,
                    parent_id: 0,
                    is_private: 0,
                    create_time: now,
                    update_time: now,
                });
                categoryNameToIdMap.set(name, newId);
            });
            didMutate = true;
        }
    }

    // --- Site Processing ---
    const existingSiteUrlMap = new Map();
    (data.sites || []).forEach(site => {
        const dbUrl = (site.url || '').trim();
        if (dbUrl) existingSiteUrlMap.set(dbUrl, dbUrl);
        getUrlMatchCandidates(dbUrl).forEach(candidate => existingSiteUrlMap.set(candidate, dbUrl));
    });

    let itemsAdded = 0;
    let itemsUpdated = 0;
    let itemsSkipped = 0;
    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';
    const processedUrls = new Set();
    const now = nowSql();

    for (const site of sitesToImport) {
        const nameResult = normalizeBookmarkName(site.name);
        const urlResult = normalizeBookmarkUrl(site.url);
        const logoResult = normalizeBookmarkLogo(site.logo);
        const descResult = normalizeBookmarkDesc(site.desc, { nullIfEmpty: true });

        if (!nameResult.ok || !urlResult.ok || !logoResult.ok || !descResult.ok) {
            itemsSkipped++;
            continue;
        }

        const rawUrl = urlResult.value;
        const sanitizedUrl = normalizeUrlForStorage(rawUrl);
        const dedupKey = sanitizedUrl.endsWith('/') ? sanitizedUrl.slice(0, -1) : sanitizedUrl;
        const sanitizedName = nameResult.value;

        if (!sanitizedUrl) {
            itemsSkipped++;
            continue;
        }
        if (processedUrls.has(dedupKey)) {
            itemsSkipped++;
            continue;
        }
        if (isNewFormat && (site.catelog_id === undefined || site.catelog_id === null)) {
            itemsSkipped++;
            continue;
        }

        const existingDbUrl = getUrlMatchCandidates(rawUrl)
            .map(candidate => existingSiteUrlMap.get(candidate))
            .find(Boolean) || null;
        const exists = Boolean(existingDbUrl);
        if (exists && !override) {
            itemsSkipped++;
            continue;
        }

        let newCatId;
        let catNameForDb; 
        let catIsPrivate = 0;

        if (isNewFormat) {
            newCatId = oldCatIdToNewCatIdMap.get(getImportIdKey(site.catelog_id));
            const catObj = existingDbCategories.find(c => String(c.id) === String(newCatId));
            if (catObj) {
                catNameForDb = catObj.catelog;
                catIsPrivate = catObj.is_private || 0;
            }
        } else {
            const catNameResult = normalizeCategoryName(site.catelog || 'Default');
            if (!catNameResult.ok) {
                itemsSkipped++;
                continue;
            }
            const catName = catNameResult.value;
            newCatId = categoryNameToIdMap.get(catName);
            catNameForDb = catName;
            const catObj = existingDbCategories.find(c => c.id === newCatId);
             if (catObj) {
                catIsPrivate = catObj.is_private || 0;
            }
        }

        if (!newCatId) {
            itemsSkipped++;
            continue;
        }

        let sanitizedLogo = logoResult.value;
        if ((!sanitizedLogo || sanitizedLogo.startsWith('data:image')) && sanitizedUrl.startsWith('http')) {
            const domain = sanitizedUrl.replace(/^https?:\/\//, '').split('/')[0];
            sanitizedLogo = `${iconAPI}${domain}`;
        }
        if (!sanitizedLogo) sanitizedLogo = null;

        const sanitizedDesc = descResult.value;
        const sortOrderValue = normalizeSortOrder(site.sort_order);
        // 覆盖更新时，若导入数据未提供排序值，则保留已有书签的排序值
        const sortOrderUpdate = (site.sort_order === undefined || site.sort_order === null)
            ? null
            : sortOrderValue;
        
        // Handle Privacy Logic
        let finalIsPrivate = site.is_private ? 1 : 0;
        // Force private if category is private
        if (catIsPrivate === 1) {
            finalIsPrivate = 1;
        }

        if (exists && override) {
            processedUrls.add(dedupKey);
            // Update
            const existing = (data.sites || []).find(s => s.url === existingDbUrl);
            if (existing) {
                existing.name = sanitizedName;
                existing.logo = sanitizedLogo;
                existing.desc = sanitizedDesc;
                existing.catelog_id = newCatId;
                existing.catelog_name = catNameForDb;
                if (sortOrderUpdate !== null) existing.sort_order = sortOrderUpdate;
                existing.is_private = finalIsPrivate;
                existing.update_time = now;
            }
            itemsUpdated++;
        } else {
            processedUrls.add(dedupKey);
            // Insert
            (data.sites = data.sites || []).push({
                id: nextId(data.sites),
                name: sanitizedName,
                url: sanitizedUrl,
                logo: sanitizedLogo,
                desc: sanitizedDesc,
                catelog_id: newCatId,
                catelog_name: catNameForDb,
                sort_order: sortOrderValue,
                is_private: finalIsPrivate,
                create_time: now,
                update_time: now,
            });
            itemsAdded++;
        }
    }

    if (didMutate || itemsAdded > 0 || itemsUpdated > 0) {
        await saveData(env, data, sha);
        await markHomeCacheDirty(env, 'all');
    }

    let msg = `导入完成。`;
    if (itemsAdded > 0) msg += ` 新增 ${itemsAdded} 个`;
    if (itemsUpdated > 0) msg += ` 更新 ${itemsUpdated} 个`;
    if (itemsSkipped > 0) msg += ` 跳过 ${itemsSkipped} 个`;

    return jsonResponse({
        code: 201,
        message: msg
    }, 201);

  } catch (error) {
    return errorResponse(`Failed to import config: ${error.message}`, 500);
  }
}