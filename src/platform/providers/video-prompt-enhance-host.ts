import {
  toDraftId,
  toProjectContextId,
  toProjectId,
  type VideoWorkspaceDraft,
  type VideoWorkspaceRepository,
  type ProjectContextRepository
} from '../../domain';
import { composeVideoPromptEnhancementInput } from '../../shared/prompt-enhancement-input';
import { freezeProjectContextOutboundSnapshots, pinProjectContextSelection } from '../repositories';
import {
  PromptEnhanceError,
  type PromptEnhanceSubjectPort,
  type PromptEnhanceSubjectSnapshot
} from './prompt-enhance-submission';

export class VideoPromptEnhanceSubjectAdapter implements PromptEnhanceSubjectPort {
  constructor(private readonly options: {
    readonly projectId: string;
    readonly drafts: VideoWorkspaceRepository;
    readonly contexts: ProjectContextRepository;
  }) {}

  async load(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
  }): Promise<PromptEnhanceSubjectSnapshot> {
    const draft = await this.options.drafts.get(toDraftId(input.subjectId));
    if (!draft || draft.projectId !== this.options.projectId) {
      throw new PromptEnhanceError('draft_not_found', 'Video draft was not found');
    }
    if (draft.updatedAt !== input.subjectRevision) {
      throw new PromptEnhanceError('draft_revision_changed', 'Video draft revision changed');
    }
    if (draft.state !== 'saved') {
      throw new PromptEnhanceError(
        'subject_invalid',
        'Video draft must be saved before prompt enhance'
      );
    }

    const { contexts, selections } = await this.resolveContexts(draft);

    return {
      subjectId: draft.id,
      subjectRevision: draft.updatedAt,
      originalInput: draft.prompt.originalInput,
      additionalPromptContent: composeVideoPromptEnhancementInput(draft).text,
      kind: 'video_workspace',
      contextSnapshots: freezeProjectContextOutboundSnapshots({
        projectId: toProjectId(this.options.projectId),
        surface: draft.mode === 'quick_video' ? 'quick' : 'professional',
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
      throw new PromptEnhanceError('draft_revision_changed', 'Video draft revision changed');
    }
    const nextDraft: VideoWorkspaceDraft = {
      ...current,
      state: 'saved',
      prompt: {
        ...current.prompt,
        finalPrompt: input.enhancedText,
        systemSupplements: [
          ...current.prompt.systemSupplements.filter((item) => item.source !== 'enhancement'),
          {
            content: input.enhancedText,
            source: 'enhancement',
            sourceReference: input.sourceReference
          }
        ]
      },
      generation: {
        ...current.generation,
        enhancement: {
          state: 'current',
          staleReasons: [],
          completedAt: input.updatedAt as VideoWorkspaceDraft['updatedAt']
        }
      },
      updatedAt: input.updatedAt as VideoWorkspaceDraft['updatedAt']
    };
    await this.options.drafts.save(nextDraft);
    return { subjectId: nextDraft.id, subjectRevision: nextDraft.updatedAt };
  }

  private async resolveContexts(draft: VideoWorkspaceDraft) {
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
    return { contexts, selections };
  }
}
