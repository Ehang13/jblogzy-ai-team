// Anthropic Claude API 래퍼 - 모델을 용도별로 분리

import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 단순 분류, 요약, 점수 계산 (저비용)
const MODEL_FAST   = 'claude-haiku-4-5-20251001';
// 블로그 글, 이메일 초안, 전략 기획 (고품질)
const MODEL_SMART  = 'claude-sonnet-4-6';

/**
 * 고품질 작업용 Claude 호출 (마케팅 콘텐츠, 이메일 초안 등)
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
export async function ask(prompt, maxTokens = 2000) {
  const msg = await client.messages.create({
    model:      MODEL_SMART,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

/**
 * 빠른 분석용 Claude 호출 (이탈 점수, 키워드 분류 등)
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
export async function askFast(prompt, maxTokens = 500) {
  const msg = await client.messages.create({
    model:      MODEL_FAST,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

/**
 * JSON 응답이 필요한 경우 자동 파싱
 * @param {string} prompt
 * @param {boolean} fast - true면 Haiku 사용
 * @returns {Promise<object>}
 */
export async function askJson(prompt, fast = false) {
  const jsonPrompt = prompt + '\n\n반드시 유효한 JSON만 출력하고 다른 텍스트는 출력하지 마세요.';
  const raw = fast ? await askFast(jsonPrompt, 1000) : await ask(jsonPrompt, 2000);

  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('Claude가 JSON을 반환하지 않았습니다: ' + raw.slice(0, 200));

  return JSON.parse(match[0]);
}
