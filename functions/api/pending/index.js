// functions/api/pending/index.js
import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';
import { parsePagination } from '../../lib/utils';
import { loadData } from '../../lib/github-data-store';

export async function onRequestGet(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  const url = new URL(request.url);
  const { page, pageSize, offset } = parsePagination(url.searchParams, { maxPageSize: 200 });

  try {
    const data = await loadData(env);
    const all = (data.pending_sites || [])
      .slice()
      .sort((a, b) => String(b.create_time || '').localeCompare(String(a.create_time || '')));

    const total = all.length;

    return jsonResponse({
      code: 200,
      data: all.slice(offset, offset + pageSize),
      total,
      page,
      pageSize
    });
  } catch (e) {
    return errorResponse(`Failed to fetch pending config data: ${e.message}`, 500);
  }
}