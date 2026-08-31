/** Renderer-local signal when the active project session changes. */
export const PROJECT_SESSION_CHANGED_EVENT = 'unicomp:project-session-changed';

export function notifyProjectSessionChanged(): void {
  window.dispatchEvent(new Event(PROJECT_SESSION_CHANGED_EVENT));
}
