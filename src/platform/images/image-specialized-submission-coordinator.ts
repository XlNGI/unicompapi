import type {
  FeatureCandidateSubjectV1,
  SubmissionUserConfirmationV1
} from '../../domain';
import type { ImageFeatureSubmissionDto } from '../../shared/image-feature-ipc';
import type { ImageSpecializedResultReceiver } from './image-specialized-result-receiver';
import type { ImageSpecializedResultV1 } from './image-specialized-result-receiver';

export interface ImageSpecializedSubmissionPort {
  submit(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }): Promise<{
    readonly submission: ImageFeatureSubmissionDto;
    readonly result?: ImageSpecializedResultV1;
  }>;
}

export class ImageSpecializedSubmissionCoordinator {
  constructor(
    private readonly port: ImageSpecializedSubmissionPort,
    private readonly receiver: ImageSpecializedResultReceiver
  ) {}

  async submit(input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
    readonly draftId: string;
    readonly expectedDraftUpdatedAt: string;
  }): Promise<ImageFeatureSubmissionDto> {
    const output = await this.port.submit({
      subject: input.subject,
      routeSelectionToken: input.routeSelectionToken,
      confirmation: input.confirmation
    });
    if ((output.submission.status === 'completed') !== Boolean(output.result)) {
      throw new TypeError('Image specialized submission/result state is inconsistent');
    }
    if (output.result) {
      await this.receiver.receive({
        draftId: input.draftId,
        expectedDraftUpdatedAt: input.expectedDraftUpdatedAt,
        result: output.result
      });
    }
    return output.submission;
  }
}
