// functions/api/pending/[id].js
import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty, normalizeSortOrder } from '../../_middleware';
import { buildFaviconUrl, getUrlMatchCandidates, normalizeUrlForStorage } from '../../lib/utils';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeBookmarkName, normalizeBookmarkUrl } from '../../lib/validators';
import { readFromGithub, saveData, nextId, nowSql } from '../../lib/github-data-store';

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = params.id;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { data, sha } = await readFromGithub(env);
    const pending = (data.pending_sites || []).find(p => String(p.id) === String(id));

    if (!pending) {
      return errorResponse('Pending config not found', 404);
    }

    const config = pending;
    let updateData = {};
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        updateData = await request.json();
      } catch {
        updateData = {};
      }
    }
    if (!updateData || typeof updateData !== 'object' || Array.isArray(updateData)) {
      updateData = {};
    }

    const hasField = (field) => Object.prototype.hasOwnProperty.call(updateData, field);
    const getField = (field, fallback) => hasField(field) ? updateData[field] : fallback;
    const catelogId = hasField('catelog_id')
      ? updateData.catelog_id
      : getField('catelogId', config.catelog_id);

    const nameResult = normalizeBookmarkName(getField('name', config.name));
    if (!nameResult.ok) return errorResponse(nameResult.message, 400);

    const urlResult = normalizeBookmarkUrl(getField('url', config.url));
    if (!urlResult.ok) return errorResponse(urlResult.message, 400);

    const logoResult = normalizeBookmarkLogo(getField('logo', config.logo), { nullIfEmpty: true });
    if (!logoResult.ok) return errorResponse(logoResult.message, 400);

    const descResult = normalizeBookmarkDesc(getField('desc', config.desc), { nullIfEmpty: true });
    if (!descResult.ok) return errorResponse(descResult.message, 400);

    const sanitizedName = nameResult.value;
    const rawUrl = urlResult.value;
    const sanitizedUrl = normalizeUrlForStorage(rawUrl);
    let sanitizedLogo = logoResult.value;
    const sanitizedDesc = descResult.value;
    const sortOrderValue = hasField('sort_order') ? normalizeSortOrder(updateData.sort_order) : 9999;
    const isPrivateValue = getField('is_private', false) ? 1 : 0;

    if (!catelogId) {
      return errorResponse('Catelog is required', 400);
    }
    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const urlCandidates = getUrlMatchCandidates(rawUrl);
    const duplicate = (data.sites || []).find(s => urlCandidates.includes(s.url));
    if (duplicate) {
      return errorResponse('该 URL 已存在，请勿重复添加', 409);
    }

    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';
    sanitizedLogo = buildFaviconUrl(sanitizedUrl, sanitizedLogo, iconAPI);
    const category = (data.categories || []).find(c => String(c.id) === String(catelogId));
    if (!category) {
      return errorResponse('Category not found.', 400);
    }
    const finalIsPrivate = Number(category.is_private) === 1 ? 1 : isPrivateValue;

    const now = nowSql();
    (data.sites = data.sites || []).push({
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

    data.pending_sites = (data.pending_sites || []).filter(p => String(p.id) !== String(id));

    await saveData(env, data, sha);

    await markHomeCacheDirty(env, finalIsPrivate ? 'private' : 'all');

    return jsonResponse({
      code: 200,
      message: 'Pending config approved successfully'
    });
  } catch (e) {
    console.error('Error approving pending config:', e);
    return errorResponse(`Failed to approve pending config: ${e.message}`, 500);
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
    data.pending_sites = (data.pending_sites || []).filter(p => String(p.id) !== String(id));
    await saveData(env, data, sha);

    return jsonResponse({
      code: 200,
      message: 'Pending config rejected successfully',
    });
  } catch (e) {
    return errorResponse(`Failed to reject pending config: ${e.message}`, 500);
  }
}