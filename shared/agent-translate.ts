/** 会话翻译只支持需求对接常用的中/英/日/韩四种语言；译文仅用于阅读，不写回会话记录。 */
import { z } from 'zod';

export const agentTranslateLanguages = ['zh', 'en', 'ja', 'ko'] as const;
export type AgentTranslateLanguage = typeof agentTranslateLanguages[number];
export const agentTranslateLanguageLabels: Record<AgentTranslateLanguage, string> = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' };
export const maxAgentTranslateLength = 20_000;
export const maxAgentTranslateBatchLength = 40_000;
export const maxAgentTranslateBatchSize = 60;

export const agentTranslateInputSchema = z.object({
  texts: z.array(z.string().min(1).max(maxAgentTranslateLength)).min(1).max(maxAgentTranslateBatchSize)
    .refine(texts => texts.reduce((total, text) => total + text.length, 0) <= maxAgentTranslateBatchLength, `单次最多翻译 ${maxAgentTranslateBatchLength} 字`),
  target: z.enum(agentTranslateLanguages),
}).strict();
export type AgentTranslateInput = z.infer<typeof agentTranslateInputSchema>;

export const agentTranslateResultSchema = z.object({ translations: z.array(z.string()) }).strict();
export type AgentTranslateResult = z.infer<typeof agentTranslateResultSchema>;

/** 按文字体系粗略判断主要语言：含假名为日文，含谚文为韩文；汉字需占一定比例才算中文，避免英文里夹带少量中文被误判。 */
export function detectAgentLanguage(text: string): AgentTranslateLanguage | 'other' {
  const count = (pattern: RegExp) => text.match(pattern)?.length || 0;
  const kana = count(/[぀-ヿ]/g), hangul = count(/[가-힯ᄀ-ᇿ]/g);
  const han = count(/[一-鿿]/g), latinWords = count(/[A-Za-z]+/g);
  if (hangul && hangul >= kana) return 'ko';
  if (kana) return 'ja';
  if (han && han >= latinWords) return 'zh';
  return latinWords ? 'en' : han ? 'zh' : 'other';
}

/** 代码、链接与路径保持原样不翻译，不参与外语段落判断。 */
const untranslatable = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|(?:[\w.@-]+\/)+[\w.@-]*/g;
/** 连续 8 个以上英文单词视为一段英文；连续 12 个以上汉字（可夹标点）视为一段中文。词与分隔符字符集互斥，避免回溯爆炸。 */
const englishPassage = /[A-Za-z][A-Za-z'’]*(?:[\s,.:;!?()"“”—–-]+[A-Za-z][A-Za-z'’]*){7,}/;
const chinesePassage = /[一-鿿](?:[，。、；：！？“”（）\s]*[一-鿿]){11,}/;

/** 中英混排时整体可能判为目标语言，但其中成段的外语仍需翻译（如中文总结前的英文过程说明）。 */
export function hasForeignPassage(text: string, target: AgentTranslateLanguage) {
  const prose = text.replace(untranslatable, ' ');
  if (target !== 'en' && englishPassage.test(prose)) return true;
  if ((target === 'en' || target === 'ko') && chinesePassage.test(prose)) return true;
  return false;
}

/** 已是目标语言且不含成段外语、或没有可读文字的内容不发送翻译；代码、链接与路径不参与语言判断。 */
export function needsAgentTranslation(text: string, target: AgentTranslateLanguage) {
  const prose = text.replace(untranslatable, ' ');
  const language = detectAgentLanguage(prose);
  if (language === 'other') return false;
  return language !== target || hasForeignPassage(prose, target);
}
