export type DirectoryAuthorizationRecord =
  | { readonly kind: 'native_picker' }
  | {
      readonly kind: 'macos_security_scoped_bookmark';
      /** Main-process-only opaque bookmark returned by Electron. */
      readonly bookmark: string;
    };

export interface DirectoryAuthorizationProbe {
  readonly state: 'granted' | 'revoked' | 'unknown';
  readonly reason?: string;
}

export interface DirectoryAuthorizationPort {
  ensureAccess(input: {
    readonly directoryId: string;
    readonly directoryPath: string;
    readonly authorization: DirectoryAuthorizationRecord;
  }): Promise<DirectoryAuthorizationProbe>;
  dispose?(): void;
}

export function parseDirectoryAuthorization(
  value: unknown
): DirectoryAuthorizationRecord {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError('Directory authorization is invalid');
  }
  if (value.kind === 'native_picker' && Object.keys(value).length === 1) {
    return { kind: 'native_picker' };
  }
  if (
    value.kind === 'macos_security_scoped_bookmark' &&
    Object.keys(value).length === 2 &&
    typeof value.bookmark === 'string' &&
    value.bookmark.length > 0 &&
    value.bookmark.length <= 1_048_576
  ) {
    return { kind: value.kind, bookmark: value.bookmark };
  }
  throw new TypeError('Directory authorization is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
