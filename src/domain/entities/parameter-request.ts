/** Declarative request rules shared by the form, preparation and provider boundary. */
export interface ParameterRequestRules {
  readonly maximumPromptCharacters?: number;
  readonly requireParameters?: boolean;
  readonly exclusiveFields?: readonly (readonly string[])[];
  readonly imageCount?: { readonly minimum: number; readonly maximum: number };
  readonly modeImageCounts?: readonly {
    readonly fieldId: string;
    readonly value: string;
    readonly minimum: number;
    readonly maximum: number;
  }[];
}

export function validateParameterRequestRules(rules: ParameterRequestRules): void {
  const validCount = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
  const validRange = (r: { minimum: number; maximum: number }) =>
    r && validCount(r.minimum) && validCount(r.maximum) && r.minimum <= r.maximum && r.maximum <= 100;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) ||
      Object.keys(rules).some(k => !['maximumPromptCharacters', 'requireParameters', 'exclusiveFields', 'imageCount', 'modeImageCounts'].includes(k)) ||
      rules.maximumPromptCharacters !== undefined && (!validCount(rules.maximumPromptCharacters) || rules.maximumPromptCharacters < 1 || rules.maximumPromptCharacters > 1000000) ||
      rules.requireParameters !== undefined && typeof rules.requireParameters !== 'boolean' ||
      rules.imageCount !== undefined && !validRange(rules.imageCount) ||
      rules.exclusiveFields !== undefined && (!Array.isArray(rules.exclusiveFields) || rules.exclusiveFields.length > 32 ||
        rules.exclusiveFields.some(g => !Array.isArray(g) || g.length < 2 || g.length > 32 || new Set(g).size !== g.length || g.some(k => typeof k !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(k)))) ||
      rules.modeImageCounts !== undefined && (!Array.isArray(rules.modeImageCounts) || rules.modeImageCounts.length > 32 ||
        rules.modeImageCounts.some(r => !validRange(r) || typeof r.fieldId !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(r.fieldId) || typeof r.value !== 'string' || !r.value.trim() || r.value.length > 128))) {
    throw new TypeError('Invalid parameter request rules');
  }
}

export function parameterRequestError(rules: ParameterRequestRules | undefined, input: {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly prompt?: string;
  readonly imageCount?: number;
}): string | undefined {
  if (!rules) return undefined;
  validateParameterRequestRules(rules);
  if (rules.maximumPromptCharacters !== undefined && input.prompt !== undefined &&
      Array.from(input.prompt).length > rules.maximumPromptCharacters) {
    return `提示词最多 ${rules.maximumPromptCharacters} 个 Unicode 字符。`;
  }
  if (rules.requireParameters && !Object.values(input.parameters).some(v => v !== undefined && v !== '')) {
    return '当前模型不接受空参数；请填写参数或选用官方示例组合。';
  }
  for (const group of rules.exclusiveFields ?? []) {
    if (group.filter(k => input.parameters[k] !== undefined).length > 1) return `参数 ${group.join(' / ')} 请只填写一项。`;
  }
  const range = rules.modeImageCounts?.find(r => input.parameters[r.fieldId] === r.value) ?? rules.imageCount;
  if (range && input.imageCount !== undefined &&
      (!Number.isSafeInteger(input.imageCount) || input.imageCount < range.minimum || input.imageCount > range.maximum)) {
    return range.minimum === range.maximum
      ? `当前生成模式需要 ${range.minimum} 张参考图片。`
      : `当前生成模式需要 ${range.minimum}–${range.maximum} 张参考图片。`;
  }
  return undefined;
}
