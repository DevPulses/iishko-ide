// FILE: iishkoModelNames.ts
// Purpose: Readable names for IISHKO gateway model ids, e.g. deepseek-v4-flash -> DeepSeek V4 Flash.
// Layer: Web IISHKO account feature

const BRAND_WORDS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  gpt: "GPT",
  glm: "GLM",
  kimi: "Kimi",
  qwen: "Qwen",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  mimo: "MiMo",
  llama: "Llama",
  mistral: "Mistral",
  minimax: "MiniMax",
  sonar: "Sonar",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

function titleWord(word: string): string {
  const brand = BRAND_WORDS[word.toLowerCase()];
  if (brand) return brand;
  if (/^v\d/iu.test(word)) return word.toUpperCase();
  if (/^\d/u.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The gateway's own title wins; otherwise the id is split on dashes and capitalised. */
export function iishkoModelDisplayName(id: string, title?: string | undefined): string {
  const given = title?.trim();
  if (given && given !== id) return given;
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.split(/[-_]/u).filter(Boolean).map(titleWord).join(" ") || id;
}
