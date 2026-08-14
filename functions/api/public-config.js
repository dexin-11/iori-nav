// functions/api/public-config.js
import { jsonResponse } from '../_middleware';
import { getSettingsKeys, parseSettings } from '../lib/settings-parser';
import { getTurnstileConfig } from '../lib/turnstile';
import { loadData, getSettingsRows } from '../lib/github-data-store';

/**
 * @summary Get public configuration settings
 * @route GET /api/public-config
 * @returns {Response} JSON response with public settings
 */
export async function onRequestGet({ env }) {
  const submissionEnabled = String(env.ENABLE_PUBLIC_SUBMISSION) === 'true';
  const turnstileConfig = getTurnstileConfig(env);

  const aiRequestDelay = parseInt(env.AI_REQUEST_DELAY, 10);
  const validAiRequestDelay = !isNaN(aiRequestDelay) && aiRequestDelay > 0 ? aiRequestDelay : 1500;

  // 复用 settings-parser 模块获取布局设置
  let layoutSettings = {};
  try {
    const data = await loadData(env);
    const rows = getSettingsRows(data, getSettingsKeys());
    layoutSettings = parseSettings(rows);
  } catch (e) {
    // 数据读取失败时使用默认值
    layoutSettings = parseSettings([]);
  }

  return jsonResponse({
    submissionEnabled,
    turnstileSiteKey: turnstileConfig.siteKey,
    aiRequestDelay: validAiRequestDelay,
    ...layoutSettings
  });
}
