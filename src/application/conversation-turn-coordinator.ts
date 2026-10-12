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
import { toProjectId, toThreadId, type IsoTimestamp, type ProjectId, type ThreadId } from '../domain';

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

  createThread(input: { readonly threadId: ThreadId | string; readonly projectId: ProjectId | string | null; readonly title: string; readonly createdAt: IsoTimestamp }) {
    return this.commands.createThread({
      ...input,
      threadId: toThreadId(String(input.threadId)),
      projectId: input.projectId === null ? null : toProjectId(String(input.projectId))
    });
  }

  acceptUserTurn(input: AcceptThreadTurnInput): Promise<AcceptedThreadTurn> {
    return this.commands.acceptUserTurn(input);
  }

  linkExecution(input: LinkThreadExecutionInput) {
    return this.projections.linkExecution(input);
  }

  projectAssistantMessage(input: ProjectAssistantMessageInput) {
    return this.projections.projectAssistantMessage(input);
  }

  saveConversation(input: Parameters<ThreadProjectionCoordinator['saveConversation']>[0]) {
    return this.projections.saveConversation(input);
  }

  projectDocumentArtifact(input: Parameters<ThreadProjectionCoordinator['projectDocumentArtifact']>[0]) {
    return this.projections.projectDocumentArtifact(input);
  }

  projectTool(input: Parameters<ThreadProjectionCoordinator['projectTool']>[0]) {
    return this.projections.projectTool(input);
  }
}
