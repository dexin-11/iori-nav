// functions/api/config/[id].js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { buildFaviconUrl, getUrlMatchCandidates, normalizeUrlForStorage } from '../../lib/utils';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeBookmarkName, normalizeBookmarkUrl } from '../../lib/validators';
import { loadData, readFromGithub, saveData, nowSql } from '../../lib/github-data-store';


export async function onRequestGet(context) {
  const { request, env, params } = context;
  const id = params.id;
  const data = await loadData(env);
  const config = (data.sites || []).find(s => String(s.id) === String(id));
  if (!config) {
    return errorResponse('config not found', 404);
  }
  
  // 私密站点需要认证才能访问
  if (Number(config.is_private) && !(await isAdminAuthenticated(request, env))) {
    return errorResponse('config not found', 404);
  }
  
  return jsonResponse({
    code: 200,
    data: config
  });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = params.id;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }
  
  try {
    const { data, sha } = await readFromGithub(env);
    const existing = (data.sites || []).find(s => String(s.id) === String(id));
    if (!existing) {
      return errorResponse('config not found', 404);
    }

    const config = await request.json();
    const { name, url, logo, desc, catelog_id, sort_order, is_private } = config;

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

    if (!catelog_id) {
      return errorResponse('Catelog is required', 400);
    }
    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const urlCandidates = getUrlMatchCandidates(rawUrl);
    const duplicate = (data.sites || []).find(s => urlCandidates.includes(s.url) && String(s.id) !== String(id));
    if (duplicate) {
      return errorResponse('该 URL 已存在，请勿重复添加', 409);
    }

    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';
    sanitizedLogo = buildFaviconUrl(sanitizedUrl, sanitizedLogo, iconAPI);

    // Fetch category name
    const category = (data.categories || []).find(c => String(c.id) === String(catelog_id));
    if (!category) {
      return errorResponse('Category not found.', 400);
    }
    const catelogName = category.catelog;

    // If category is private, force site to be private
    let finalIsPrivate = isPrivateValue;
    if (Number(category.is_private) === 1) {
        finalIsPrivate = 1;
    }

    existing.name = sanitizedName;
    existing.url = sanitizedUrl;
    existing.logo = sanitizedLogo;
    existing.desc = sanitizedDesc;
    existing.catelog_id = category.id;
    existing.catelog_name = catelogName;
    existing.sort_order = sortOrderValue;
    existing.is_private = finalIsPrivate;
    existing.update_time = nowSql();

    await saveData(env, data, sha);

    const dirtyScope = (Number(existing.is_private) === 1 && finalIsPrivate === 1) ? 'private' : 'all';
    await markHomeCacheDirty(env, dirtyScope);

    return jsonResponse({
      code: 200,
      message: 'Config updated successfully'
    });
  } catch (e) {
    return errorResponse(`Failed to update config: ${e.message}`, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const id = params.id;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { data, sha } = await readFromGithub(env);
    const existing = (data.sites || []).find(s => String(s.id) === String(id));
    if (!existing) {
      return errorResponse('config not found', 404);
    }

    data.sites = (data.sites || []).filter(s => String(s.id) !== String(id));
    await saveData(env, data, sha);

    await markHomeCacheDirty(env, Number(existing.is_private) ? 'private' : 'all');

    return jsonResponse({
      code: 200,
      message: 'Config deleted successfully'
    });
  } catch (e) {
    return errorResponse(`Failed to delete config: ${e.message}`, 500);
  }
}