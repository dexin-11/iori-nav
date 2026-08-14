// functions/api/config/submit.js
import { isSubmissionEnabled, errorResponse, jsonResponse, checkRateLimit } from '../../_middleware';
import { normalizeUrlForStorage } from '../../lib/utils';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { normalizeBookmarkDesc, normalizeBookmarkLogo, normalizeBookmarkName, normalizeBookmarkUrl } from '../../lib/validators';
import { readFromGithub, saveData, nextId, nowSql } from '../../lib/github-data-store';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isSubmissionEnabled(env)) {
    return errorResponse('Public submission disabled', 403);
  }

  // 基于 IP 的速率限制：每 IP 每分钟最多 5 次提交
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const { allowed } = await checkRateLimit(env, `submit_rate_${ip}`, 5, 60);
  if (!allowed) {
    return errorResponse('提交过于频繁，请稍后再试', 429);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelog_id, turnstileToken } = config;

    const turnstileResult = await verifyTurnstileToken(turnstileToken, env, ip);
    if (!turnstileResult.ok) {
      return errorResponse(turnstileResult.message, 403);
    }

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
    const sanitizedLogo = logoResult.value;
    const sanitizedDesc = descResult.value;

    if (!catelog_id) {
      return errorResponse('Category is required', 400);
    }
    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const { data, sha } = await readFromGithub(env);
    const category = (data.categories || []).find(c => String(c.id) === String(catelog_id));
    if (!category || Number(category.is_private) === 1) {
      return errorResponse('Category not found', 400);
    }
    const catelogName = category.catelog;

    data.pending_sites.push({
      id: nextId(data.pending_sites),
      name: sanitizedName,
      url: sanitizedUrl,
      logo: sanitizedLogo,
      desc: sanitizedDesc,
      catelog_id: category.id,
      catelog_name: catelogName,
      create_time: nowSql(),
    });
    await saveData(env, data, sha);

    return jsonResponse({
      code: 201,
      message: 'Config submitted successfully, waiting for admin approve',
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to submit config: ${e.message}`, 500);
  }
}
