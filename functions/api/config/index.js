// functions/api/config/index.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { buildFaviconUrl, getUrlMatchCandidates, normalizeUrlForStorage, parsePagination } from '../../lib/utils';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeBookmarkName, normalizeBookmarkUrl } from '../../lib/validators';
import { loadData, readFromGithub, saveData, nextId, nowSql } from '../../lib/github-data-store';

const MAX_CONFIG_SEARCH_KEYWORD_LENGTH = 100;

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const catalog = url.searchParams.get('catalog');
  const catalogId = url.searchParams.get('catalogId');
  const { page, pageSize, offset } = parsePagination(url.searchParams, { maxPageSize: 200 });
  const keyword = (url.searchParams.get('keyword') || '').trim();

  if (keyword.length > MAX_CONFIG_SEARCH_KEYWORD_LENGTH) {
    return errorResponse(`搜索关键词不能超过 ${MAX_CONFIG_SEARCH_KEYWORD_LENGTH} 个字符`, 400);
  }

  const isAuthenticated = await isAdminAuthenticated(request, env);
  const includePrivate = isAuthenticated ? 1 : 0;

  try {
    const data = await loadData(env);
    const kw = keyword.toLowerCase();
    let results = (data.sites || []).filter(s => {
      if (Number(s.is_private) !== 0 && includePrivate !== 1) return false;
      if (catalogId && String(s.catelog_id) !== String(catalogId)) return false;
      if (catalog && s.catelog_name !== catalog) return false;
      if (kw) {
        const haystack = [s.name, s.url, s.catelog_name, s.desc].map(v => String(v ?? '')).join(' ').toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });

    const total = results.length;
    results = results
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(b.create_time || '').localeCompare(String(a.create_time || '')))
      .slice(offset, offset + pageSize);

    return jsonResponse({
      code: 200,
      data: results,
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch config data: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelogId, sort_order, is_private } = config;
    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';

    const nameResult = normalizeBookmarkName(name);
    if (!nameResult.ok) return errorResponse(nameResult.message, 400);

    const urlResult = normalizeBookmarkUrl(url);
    if (!urlResult.ok) return errorResponse(urlResult.message, 400);

    const logoResult = normalizeBookmarkLogo(logo, { nullIfEmpty: true });
    if (!logoResult.ok) return errorResponse(logoResult.message, 400);

    const descResult = normalizeBookmarkDesc(desc, { nullIfEmpty: true });
    if (!descResult.ok) return errorResponse(descResult.message, 400);

    const sanitizedName = nameResult.value;
    const rawUrl = urlResult.value;
    const sanitizedUrl = normalizeUrlForStorage(rawUrl);
    let sanitizedLogo = logoResult.value;
    const sanitizedDesc = descResult.value;
    const sortOrderValue = normalizeSortOrder(sort_order);
    const isPrivateValue = is_private ? 1 : 0;

    if (!catelogId) {
      return errorResponse('Catelog is required', 400);
    }

    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const { data, sha } = await readFromGithub(env);

    // Check if URL already exists
    const urlCandidates = getUrlMatchCandidates(rawUrl);
    const existingSite = (data.sites || []).find(s => urlCandidates.includes(s.url));
    if (existingSite) {
        return errorResponse('该 URL 已存在，请勿重复添加', 409);
    }

    sanitizedLogo = buildFaviconUrl(sanitizedUrl, sanitizedLogo, iconAPI);
    // Find the category from the category id
    const category = (data.categories || []).find(c => String(c.id) === String(catelogId));

    if (!category) {
      return errorResponse(`Category not found.`, 400);
    }
    
    // If category is private, force site to be private
    let finalIsPrivate = isPrivateValue;
    if (Number(category.is_private) === 1) {
        finalIsPrivate = 1;
    }

    const now = nowSql();
    data.sites.push({
      id: nextId(data.sites),
      name: sanitizedName,
      url: sanitizedUrl,
      logo: sanitizedLogo,
      desc: sanitizedDesc,
      catelog_id: category.id,
      catelog_name: category.catelog,
      sort_order: sortOrderValue,
      is_private: finalIsPrivate,
      create_time: now,
      update_time: now,
    });

    await saveData(env, data, sha);
    await markHomeCacheDirty(env, finalIsPrivate ? 'private' : 'all');

    return jsonResponse({
      code: 201,
      message: 'Config created successfully'
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to create config: ${e.message}`, 500);
  }
}