// functions/api/categories/create.js
import { isAdminAuthenticated, errorResponse, jsonResponse, normalizeSortOrder, markHomeCacheDirty } from '../../_middleware';
import { normalizeCategoryName } from '../../lib/validators';
import { readFromGithub, saveData, nextId, nowSql } from '../../lib/github-data-store';

export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const body = await request.json();
    const categoryNameResult = normalizeCategoryName(body.catelog);
    
    if (!categoryNameResult.ok) {
      return errorResponse(categoryNameResult.message, 400);
    }
    const categoryName = categoryNameResult.value;

    const parentId = body.parent_id ? parseInt(body.parent_id, 10) : 0;

    const { data, sha } = await readFromGithub(env);
    const categories = data.categories || [];

    let parentCategory = null;

    // 检查父分类存在性
    if (parentId !== 0) {
      parentCategory = categories.find(c => Number(c.id) === parentId);
      if (!parentCategory) {
        return errorResponse('父分类不存在', 400);
      }
    }

    // 检查在同一个父分类下，分类名称是否已存在
    const normalizedParentId = (parentId === null || parentId === undefined) ? 0 : parentId;
    const existing = categories.find(c =>
      c.catelog === categoryName && (Number(c.parent_id) || 0) === normalizedParentId
    );

    if (existing) {
      return errorResponse('该分类名称在当前父分类下已存在', 400);
    }

    // 获取排序值,如果未提供则使用 9999
    const sortOrderValue = normalizeSortOrder(body.sort_order);
    const isPrivate = parentCategory?.is_private === 1 ? 1 : (body.is_private ? 1 : 0);

    const now = nowSql();
    categories.push({
      id: nextId(categories),
      catelog: categoryName,
      sort_order: sortOrderValue,
      parent_id: parentId,
      is_private: isPrivate,
      create_time: now,
      update_time: now,
    });

    await saveData(env, data, sha);
    await markHomeCacheDirty(env, isPrivate ? 'private' : 'all');

    return jsonResponse({
      code: 201,
      message: '分类创建成功',
      data: {
        catelog: categoryName,
        sort_order: sortOrderValue,
        parent_id: parentId,
        is_private: isPrivate
      }
    }, 201);
  } catch (e) {
    return errorResponse(`创建分类失败: ${e.message}`, 500);
  }
}