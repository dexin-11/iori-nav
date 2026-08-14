// functions/api/categories/index.js
import { isAdminAuthenticated, isSubmissionEnabled, errorResponse, jsonResponse } from '../../_middleware';
import { parsePagination } from '../../lib/utils';
import { loadData } from '../../lib/github-data-store';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const isPublicScope = url.searchParams.get('scope') === 'public';

  const isAuthenticated = await isAdminAuthenticated(request, env);

  if ((!isAuthenticated || isPublicScope) && !isSubmissionEnabled(env)) {
    return errorResponse('Unauthorized', 401);
  }

  const shouldShowPublicOnly = isPublicScope || !isAuthenticated;
  const maxPageSize = shouldShowPublicOnly ? 1000 : 10000;
  const { page, pageSize, offset } = parsePagination(url.searchParams, { maxPageSize });

  try {
    const data = await loadData(env);
    const allCategories = shouldShowPublicOnly
      ? (data.categories || []).filter(c => Number(c.is_private) === 0)
      : (data.categories || []).slice();

    const sites = data.sites || [];
    const results = allCategories
      .map(c => {
        const countSites = shouldShowPublicOnly
          ? sites.filter(s => String(s.catelog_id) === String(c.id) && Number(s.is_private) === 0)
          : sites.filter(s => String(s.catelog_id) === String(c.id));
        return {
          id: c.id,
          catelog: c.catelog,
          sort_order: c.sort_order,
          parent_id: c.parent_id,
          is_private: c.is_private,
          site_count: countSites.length,
        };
      })
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(b.create_time || '').localeCompare(String(a.create_time || '')));

    const total = results.length;

    return jsonResponse({
      code: 200,
      data: results.slice(offset, offset + pageSize),
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch categories: ${e.message}`, 500);
  }
}