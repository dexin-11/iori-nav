// functions/api/get-empty-desc-sites.js
import { isAdminAuthenticated, errorResponse, jsonResponse } from '../_middleware';
import { loadData } from '../lib/github-data-store';

export async function onRequestGet(context) {
  const { request, env } = context;

  // 1. 身份验证
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    // 2. 查询描述为空或NULL的记录
    const data = await loadData(env);
    const results = (data.sites || [])
      .filter(s => !s.desc || String(s.desc).trim() === '')
      .map(s => ({ id: s.id, name: s.name, url: s.url, logo: s.logo }));

    // 3. 返回结果
    return jsonResponse({
      code: 200,
      data: results,
    });

  } catch (e) {
    console.error('Error fetching sites with empty description:', e);
    return errorResponse(`Failed to fetch sites: ${e.message}`, 500);
  }
}