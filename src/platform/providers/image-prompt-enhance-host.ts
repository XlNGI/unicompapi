import {
  toDraftId,
  toProjectContextId,
  toProjectId,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type ProjectContextRepository
} from '../../domain';
import { freezeProjectContextOutboundSnapshots, pinProjectContextSelection } from '../repositories';
import {
  PromptEnhanceError,
  type PromptEnhanceSubjectPort,
  type PromptEnhanceSubjectSnapshot
} from './prompt-enhance-submission';

export class ImagePromptEnhanceSubjectAdapter implements PromptEnhanceSubjectPort {
  constructor(private readonly options: {
    readonly projectId: string;
    readonly drafts: ImageWorkspaceRepository;
    readonly contexts: ProjectContextRepository;
  }) {}

  async load(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
  }): Promise<PromptEnhanceSubjectSnapshot> {
    const draft = await this.options.drafts.get(toDraftId(input.subjectId));
    if (!draft || draft.projectId !== this.options.projectId) {
      throw new PromptEnhanceError('draft_not_found', 'Image draft was not found');
    }
    if (draft.updatedAt !== input.subjectRevision) {
      throw new PromptEnhanceError('draft_revision_changed', 'Image draft revision changed');
    }
    if (draft.state !== 'saved') {
      throw new PromptEnhanceError(
        'subject_invalid',
        'Image draft must be saved before prompt enhance'
      );
    }

    const selections = [];
    const contexts = [];
    for (const reference of draft.contextReferences) {
      if (reference.kind !== 'project_context') {
        throw new PromptEnhanceError(
          'subject_invalid',
          'Prompt enhance only accepts registered project contexts'
        );
      }
      if (reference.contextRevision === undefined || reference.includeInPrompt === undefined) {
        throw new PromptEnhanceError(
          'subject_invalid',
          'Project context must be selected again to pin a revision'
        );
      }
      const context = await this.options.contexts.get(toProjectContextId(reference.referenceId));
      if (!context) {
        throw new PromptEnhanceError(
          'subject_invalid',
          'Selected project context is unavailable'
        );
      }
      contexts.push(context);
      selections.push(pinProjectContextSelection(
        context,
        reference.contextRevision,
        reference.includeInPrompt
      ));
    }

    return {
      subjectId: draft.id,
      subjectRevision: draft.updatedAt,
      originalInput: draft.prompt.originalInput,
      contextSnapshots: freezeProjectContextOutboundSnapshots({
        projectId: toProjectId(this.options.projectId),
        surface: 'professional',
        contexts,
        selections
      })
    };
  }

  async saveEnhancement(input: {
    readonly subject: PromptEnhanceSubjectSnapshot;
    readonly enhancedText: string;
    readonly sourceReference: string;
    readonly updatedAt: string;
  }): Promise<{ readonly subjectId: string; readonly subjectRevision: string }> {
    const current = await this.options.drafts.get(toDraftId(input.subject.subjectId));
    if (!current || current.updatedAt !== input.subject.subjectRevision) {
      throw new PromptEnhanceError('draft_revision_changed', 'Image draft revision changed');
    }
    const nextDraft: ImageWorkspaceDraft = {
      ...current,
      state: 'saved',
      prompt: {
        ...current.prompt,
        systemSupplements: [
          ...current.prompt.systemSupplements.filter((item) => item.source !== 'enhancement'),
          {
            content: input.enhancedText,
            source: 'enhancement',
            sourceReference: input.sourceReference
          }
        ]
      },
      updatedAt: input.updatedAt as ImageWorkspaceDraft['updatedAt']
    };
    await this.options.drafts.save(nextDraft);
    return { subjectId: nextDraft.id, subjectRevision: nextDraft.updatedAt };
  }
}
