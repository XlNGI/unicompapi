import type { DocumentWorkspaceKind } from '../domain';

export interface OfficeTheme {
  readonly name: string;
  readonly colors: {
    readonly primary: string;
    readonly accent: string;
    readonly text: string;
    readonly textLight: string;
    readonly background: string;
    readonly border: string;
  };
  readonly table: {
    readonly headerFill: string;
    readonly headerTextColor: string;
    readonly zebraEvenFill: string;
    readonly zebraOddFill: string;
    readonly borderColor: string;
  };
  readonly chart: {
    readonly palette: readonly string[];
  };
  readonly fonts: {
    readonly heading: string;
    readonly body: string;
    readonly headingSizePt: number;
    readonly bodySizePt: number;
  };
}

export const DEFAULT_OFFICE_THEME: OfficeTheme = {
  name: 'Default',
  colors: {
    primary: '#2E7D32',
    accent: '#1976D2',
    text: '#212121',
    textLight: '#757575',
    background: '#FFFFFF',
    border: '#E0E0E0'
  },
  table: {
    headerFill: '#2E7D32',
    headerTextColor: '#FFFFFF',
    zebraEvenFill: '#F5F5F5',
    zebraOddFill: '#FFFFFF',
    borderColor: '#BDBDBD'
  },
  chart: {
    palette: ['#2E7D32', '#1976D2', '#F57C00', '#7B1FA2', '#C62828', '#00796B']
  },
  fonts: {
    heading: 'Arial',
    body: 'Arial',
    headingSizePt: 14,
    bodySizePt: 11
  }
};

export function getThemeForDocument(
  kind: DocumentWorkspaceKind
): OfficeTheme {
  return DEFAULT_OFFICE_THEME;
}
