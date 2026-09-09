import type {
  PromptEnhanceSubjectPort,
  PromptEnhanceSubjectSnapshot
} from './prompt-enhance-submission';

export class WorkspacePromptEnhanceSubjectAdapter implements PromptEnhanceSubjectPort {
  constructor(
    private readonly image: PromptEnhanceSubjectPort,
    private readonly video: PromptEnhanceSubjectPort
  ) {}

  async load(input: {
    readonly subjectId: string;
    readonly subjectRevision: string;
  }): Promise<PromptEnhanceSubjectSnapshot> {
    try {
      return await this.image.load(input);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Image draft was not found')) {
        return await this.video.load(input);
      }
      throw error;
    }
  }

  async saveEnhancement(input: {
    readonly subject: PromptEnhanceSubjectSnapshot;
    readonly enhancedText: string;
    readonly sourceReference: string;
    readonly updatedAt: string;
  }): Promise<{ readonly subjectId: string; readonly subjectRevision: string }> {
    return input.subject.kind === 'image_workspace'
      ? this.image.saveEnhancement(input)
      : this.video.saveEnhancement(input);
  }
}
