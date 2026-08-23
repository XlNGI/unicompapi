export const documentThemeIds = ['blueprint', 'ink', 'forest', 'financing'] as const;
export type DocumentThemeId = (typeof documentThemeIds)[number];

export interface DocumentTheme {
  readonly id: DocumentThemeId | 'custom';
  readonly name: string;
  readonly accent: string;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  /** Native editable PPT layout family used by the theme. */
  readonly presentationStyle?: 'standard' | 'financing';
}

export const documentThemes: Readonly<Record<DocumentThemeId, DocumentTheme>> = {
  blueprint: {
    id: 'blueprint',
    name: '商务蓝',
    accent: '1F5FBF',
    background: 'FFFFFF',
    text: '1A1A1A',
    muted: '666666'
  },
  ink: {
    id: 'ink',
    name: '墨色',
    accent: '1F2937',
    background: 'F8F8F6',
    text: '111111',
    muted: '555555'
  },
  forest: {
    id: 'forest',
    name: '松绿',
    accent: '2E7D5B',
    background: 'FFFFFF',
    text: '14231B',
    muted: '5A6B61'
  },
  financing: {
    id: 'financing',
    name: '融资演讲稿',
    accent: '078AA3',
    background: 'FFFFFF',
    text: '111111',
    muted: '666666',
    presentationStyle: 'financing'
  }
};

export function resolveDocumentTheme(
  value: unknown,
  fallback: DocumentThemeId = 'blueprint'
): DocumentTheme {
  return documentThemes[
    typeof value === 'string' &&
    documentThemeIds.includes(value as DocumentThemeId)
      ? (value as DocumentThemeId)
      : fallback
  ];
}
