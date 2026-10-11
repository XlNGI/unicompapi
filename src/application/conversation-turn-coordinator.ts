import type {
  ThreadCommandService,
  AcceptThreadTurnInput,
  AcceptedThreadTurn
} from './thread-command-service';
import type {
  ThreadProjectionCoordinator,
  LinkThreadExecutionInput,
  ProjectAssistantMessageInput
} from './thread-projection-coordinator';

/**
 * The single application boundary between a user Turn and the existing
 * execution runtimes. It owns transcript acceptance and projections only;
 * Provider, Agent and Document runtimes remain the execution authorities.
 */
export class ConversationTurnCoordinator {
  constructor(
    private readonly commands: ThreadCommandService,
    private readonly projections: ThreadProjectionCoordinator
  ) {}

  acceptUserTurn(input: AcceptThreadTurnInput): Promise<AcceptedThreadTurn> {
    return this.commands.acceptUserTurn(input);
  }

  linkExecution(input: LinkThreadExecutionInput) {
    return this.projections.linkExecution(input);
  }

  projectAssistantMessage(input: ProjectAssistantMessageInput) {
    return this.projections.projectAssistantMessage(input);
  }

  projectDocumentArtifact(input: Parameters<ThreadProjectionCoordinator['projectDocumentArtifact']>[0]) {
    return this.projections.projectDocumentArtifact(input);
  }

  projectTool(input: Parameters<ThreadProjectionCoordinator['projectTool']>[0]) {
    return this.projections.projectTool(input);
  }
}
