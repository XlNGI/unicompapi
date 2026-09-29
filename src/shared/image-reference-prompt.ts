const imageReferencePattern = /图(\d+)(?!\d)/gu;
const invalidImageReferenceSuffix = '（已失效）';

export function remapDeletedImageReferences(
  prompt: string,
  deletedIndex: number
): string {
  if (!Number.isSafeInteger(deletedIndex) || deletedIndex < 1) return prompt;
  return prompt.replace(imageReferencePattern, (token, rawIndex: string) => {
    const index = Number(rawIndex);
    if (index === deletedIndex) return `${token}${invalidImageReferenceSuffix}`;
    return index > deletedIndex ? `图${index - 1}` : token;
  });
}

export function hasInvalidImageReference(prompt: string): boolean {
  return prompt.includes(invalidImageReferenceSuffix);
}
