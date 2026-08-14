import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';
import { readFromGithub, saveData, nowSql } from '../../lib/github-data-store';

export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { action, ids, payload } = await request.json();

    const requiresIds = action !== 'reorder';

    if (requiresIds && (!ids || !Array.isArray(ids) || ids.length === 0)) {
      return errorResponse('未提供 ID', 400);
    }

    const { data, sha } = await readFromGithub(env);
    const idSet = new Set((ids || []).map(String));
    const now = nowSql();

    if (action === 'delete') {
      data.sites = (data.sites || []).filter(s => !idSet.has(String(s.id)));
      await saveData(env, data, sha);
      await markHomeCacheDirty(env, 'all');
      
      return jsonResponse({
        code: 200,
        message: `成功删除 ${ids.length} 条项目`
      });

    } else if (action === 'update_category') {
      const { categoryId } = payload;
      if (!categoryId) {
        return errorResponse('分类 ID 是必填项', 400);
      }

      const category = (data.categories || []).find(c => String(c.id) === String(categoryId));
      if (!category) {
        return errorResponse('找不到分类', 404);
      }

      let updated = 0;
      (data.sites || []).forEach(s => {
        if (!idSet.has(String(s.id))) return;
        s.catelog_id = category.id;
        s.catelog_name = category.catelog;
        if (Number(category.is_private) === 1) {
          s.is_private = 1;
        }
        s.update_time = now;
        updated++;
      });

      await saveData(env, data, sha);
      await markHomeCacheDirty(env, 'all');

      return jsonResponse({
        code: 200,
        message: `成功更新 ${updated} 条项目的分类`
      });

    } else if (action === 'update_privacy') {
      const { isPrivate } = payload;
      if (isPrivate === undefined) {
        return errorResponse('隐私状态是必填项', 400);
      }
      
      const isPrivateValue = isPrivate ? 1 : 0;
      let updated = 0;
      (data.sites || []).forEach(s => {
        if (!idSet.has(String(s.id))) return;
        s.is_private = isPrivateValue;
        s.update_time = now;
        updated++;
      });

      await saveData(env, data, sha);
      await markHomeCacheDirty(env, 'all');

      return jsonResponse({
        code: 200,
        message: `成功更新 ${updated} 条项目的隐私属性`
      });
    } else if (action === 'reorder') {
      const items = payload?.items;

      if (!Array.isArray(items) || items.length === 0) {
        return errorResponse('排序数据不能为空', 400);
      }

      const byId = new Map((data.sites || []).map(s => [String(s.id), s]));
      let updated = 0;

      for (const item of items) {
        const id = Number(item.id);
        const sortOrder = Number(item.sort_order);

        if (!Number.isFinite(id) || !Number.isFinite(sortOrder)) {
          return errorResponse('排序数据格式无效', 400);
        }
        const site = byId.get(String(id));
        if (!site) continue;
        site.sort_order = sortOrder;
        site.update_time = now;
        updated++;
      }

      await saveData(env, data, sha);
      await markHomeCacheDirty(env, 'all');

      return jsonResponse({
        code: 200,
        message: `成功更新 ${updated} 条项目的排序`
      });
    } else {
      return errorResponse('无效的操作', 400);
    }

  } catch (e) {
    return errorResponse(`批量操作失败: ${e.message}`, 500);
  }
}