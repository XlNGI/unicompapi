import type { DocumentOutlineSection } from '../domain';

export type RevisionTargetUnit = 'section' | 'page';

export type DocumentRevisionPatch =
  | {
      readonly operation: 'clear_section';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly pageNumber?: number;
        readonly targetUnit?: RevisionTargetUnit;
      };
    }
  | {
      readonly operation: 'replace_section';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly pageNumber?: number;
        readonly targetUnit?: RevisionTargetUnit;
      };
      readonly replacement: DocumentOutlineSection;
    }
  | {
      readonly operation: 'replace_text';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly blockIndex: number;
        readonly targetUnit?: RevisionTargetUnit;
      };
      readonly value: string;
    }
  | {
      readonly operation: 'update_cells';
      readonly target: {
        readonly sectionIndex: number;
        readonly sectionHeading: string;
        readonly blockIndex: number;
        readonly rowIndex: number;
        readonly columnIndex: number;
        readonly targetUnit?: RevisionTargetUnit;
      };
      readonly value: string;
    };
