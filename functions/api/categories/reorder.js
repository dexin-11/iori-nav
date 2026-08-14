import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';
import { readFromGithub, saveData, nowSql } from '../../lib/github-data-store';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { items } = await request.json();

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse('排序数据不能为空', 400);
    }

    const { data, sha } = await readFromGithub(env);
    const byId = new Map((data.categories || []).map(c => [String(c.id), c]));
    const now = nowSql();
    let updated = 0;

    for (const item of items) {
      const id = Number(item.id);
      const sortOrder = Number(item.sort_order);

      if (!Number.isFinite(id) || !Number.isFinite(sortOrder)) {
        return errorResponse('排序数据格式无效', 400);
      }

      const category = byId.get(String(id));
      if (!category) continue;
      category.sort_order = sortOrder;
      category.update_time = now;
      updated++;
    }

    await saveData(env, data, sha);
    await markHomeCacheDirty(env, 'all');

    return jsonResponse({
      code: 200,
      message: `成功更新 ${updated} 个分类的排序`
    });
  } catch (e) {
    return errorResponse(`保存分类排序失败: ${e.message}`, 500);
  }
}