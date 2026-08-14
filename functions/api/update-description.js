// functions/api/update-description.js
import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../_middleware';
import { buildFaviconUrl } from '../lib/utils';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeOptionalBookmarkUrl } from '../lib/validators';
import { readFromGithub, saveData, nowSql } from '../lib/github-data-store';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. 身份验证
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { id, description, url, logo } = await request.json();

    // 2. 输入验证
    if (!id || typeof description !== 'string') {
      return errorResponse('Bookmark ID and description are required', 400);
    }

    const descResult = normalizeBookmarkDesc(description);
    if (!descResult.ok) return errorResponse(descResult.message, 400);

    const urlResult = normalizeOptionalBookmarkUrl(url);
    if (!urlResult.ok) return errorResponse(urlResult.message, 400);

    const logoResult = normalizeBookmarkLogo(logo, { nullIfEmpty: true });
    if (!logoResult.ok) return errorResponse(logoResult.message, 400);

    const { data, sha } = await readFromGithub(env);
    const site = (data.sites || []).find(s => String(s.id) === String(id));

    if (!site) {
      return errorResponse('Bookmark not found', 404);
    }

    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';
    const sanitizedLogo = buildFaviconUrl(urlResult.value, logoResult.value, iconAPI);

    // 3. 更新数据
    site.desc = descResult.value;
    site.logo = sanitizedLogo;
    site.update_time = nowSql();
    await saveData(env, data, sha);

    await markHomeCacheDirty(env, site.is_private ? 'private' : 'all');

    // 4. 返回成功响应
    return jsonResponse({
      code: 200,
      message: 'Description updated successfully',
    });

  } catch (e) {
    console.error('Error updating description:', e);
    return errorResponse(`Failed to update description: ${e.message}`, 500);
  }
}
