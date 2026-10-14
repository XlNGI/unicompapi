/** Only an explicit renderer copy action may call this write-only desktop bridge. */
export interface TextClipboardApi {
  writeText(text: string): Promise<void>;
}
