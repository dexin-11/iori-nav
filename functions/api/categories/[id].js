// functions/api/categories/[id].js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { normalizeCategoryName } from '../../lib/validators';
import { readFromGithub, saveData, nowSql } from '../../lib/github-data-store';

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

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const categoryId = decodeURIComponent(params.id);
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const body = await request.json();
    
    if (!categoryId) {
      return errorResponse('Category id is required', 400);
    }

    const { data, sha } = await readFromGithub(env);
    const categories = data.categories || [];

    if (body && body.reset) {
      // 1. Check for sub-categories
      const hasChildren = categories.some(c => String(c.parent_id) === String(categoryId));
      if (hasChildren) {
        return errorResponse('无法删除：该分类包含子分类，请先删除或移动子分类', 400);
      }

      // 2. Check for associated sites (bookmarks)
      const hasSites = (data.sites || []).some(s => String(s.catelog_id) === String(categoryId));
      if (hasSites) {
        return errorResponse('无法删除：该分类包含书签，请先删除或移动书签', 400);
      }

      data.categories = categories.filter(c => String(c.id) !== String(categoryId));
      await saveData(env, data, sha);
      await markHomeCacheDirty(env, 'all');
      
      return jsonResponse({
        code: 200,
        message: 'Category deleted successfully'
      });
    }

    const categoryNameResult = normalizeCategoryName(body.catelog);
    let { sort_order } = body;

    if (!categoryNameResult.ok) {
      return errorResponse(categoryNameResult.message, 400);
    }
    const catelog = categoryNameResult.value;

    const parentId = body.parent_id !== undefined ? parseInt(body.parent_id, 10) : 0;

    // 检查 parent_id 不能指向自身
    if (parentId !== 0 && String(parentId) === String(categoryId)) {
      return errorResponse('分类不能设为自身的子分类', 400);
    }

    // 检查 parent_id 存在性及循环引用
    let parentCategory = null;
    if (parentId !== 0) {
      parentCategory = categories.find(c => String(c.id) === String(parentId));
      if (!parentCategory) {
        return errorResponse('父分类不存在', 400);
      }
      // 沿 parent 链向上查找，检测循环（限制最大深度防止异常数据）
      let currentParent = parentId;
      const visited = new Set([parseInt(categoryId, 10)]);
      let depth = 0;
      while (currentParent !== 0 && depth++ < 20) {
        if (visited.has(currentParent)) {
          return errorResponse('不允许创建循环引用的分类层级', 400);
        }
        visited.add(currentParent);
        const row = categories.find(c => String(c.id) === String(currentParent));
        if (!row) break;
        currentParent = Number(row.parent_id) || 0;
      }
    }

    // 检查在同一个父分类下，分类名称是否已存在（排除自身）
    const existingCategory = categories.find(
      c => c.catelog === catelog && String(c.parent_id) === String(parentId) && String(c.id) !== String(categoryId)
    );

    if (existingCategory) {
      return errorResponse('该分类名称在当前父分类下已存在', 409);
    }

    sort_order = normalizeSortOrder(sort_order);
    const isPrivate = parentCategory?.is_private === 1 ? 1 : (body.is_private ? 1 : 0);

    const category = categories.find(c => String(c.id) === String(categoryId));
    if (!category) {
      return errorResponse('分类不存在', 404);
    }
    category.catelog = catelog;
    category.sort_order = sort_order;
    category.parent_id = parentId;
    category.is_private = isPrivate;
    category.update_time = nowSql();

    // 同步更新该分类下所有书签的 catelog_name
    (data.sites || []).forEach(s => {
      if (String(s.catelog_id) === String(categoryId)) s.catelog_name = catelog;
    });

    // A private category makes the whole subtree private so public navigation cannot expose descendants.
    if (isPrivate === 1) {
      const ids = new Set(getDescendantIds(categories, categoryId));
      categories.forEach(c => { if (ids.has(String(c.id))) c.is_private = 1; });
      (data.sites || []).forEach(s => { if (ids.has(String(s.catelog_id))) s.is_private = 1; });
    }

    await saveData(env, data, sha);
    await markHomeCacheDirty(env, 'all');

    return jsonResponse({
      code: 200,
      message: 'Category updated successfully'
    });
   
  } catch (e) {
    return errorResponse(`Failed to process category request: ${e.message}`, 500);
  }
}