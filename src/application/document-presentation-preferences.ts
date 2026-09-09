/** Read only the current user's document requirements, never attachment or model content.
 * Image generation still requires the existing cost confirmation before execution.
 */
export function documentPresentationPreferences(requirements: string): {
  readonly theme: 'blueprint' | 'ink' | 'forest' | 'financing';
  readonly aiImagesRequested: boolean;
} {
  const text = requirements.toLowerCase();
  // Ambiguous/negative references cannot enable an additional paid tool.
  const declined = /不|无需|无须|禁止|取消|别|不要|仅文字|纯文字|\b(?:no|not|without|disable)\b/u.test(text);
  const aiImagesRequested = !declined &&
    /(?:用|使用|采用|需要|开启|添加|加入|生成|制作|帮我|请).{0,8}ai\s*(?:生成)?\s*(?:配图|插图|图片)|ai\s*(?:配图|插图)\s*(?:生成|开启)|\b(?:add|generate|use)\s+ai\s+(?:images|illustrations)\b/iu.test(text);
  const theme = /墨色|黑白|极简/u.test(text) ? 'ink'
    : /松绿|绿色|自然|环保/u.test(text) ? 'forest'
      : /融资|路演|投资人/u.test(text) ? 'financing' : 'blueprint';
  return { theme, aiImagesRequested };
}
