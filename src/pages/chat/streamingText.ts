/** A display-only buffer; persisted response text always stays complete. */
export class StreamingTextBuffer {
  private target = '';
  private shown = '';
  private deadline = 0;
  private lastTick = 0;

  update(content: string, streaming: boolean, now: number): string {
    if (!streaming || !content.startsWith(this.target)) {
      this.target = this.shown = content;
      this.lastTick = now;
      return this.shown;
    }
    if (content !== this.target) {
      this.target = content;
      this.deadline = now + 100;
      this.lastTick = now;
    }
    return this.shown;
  }

  advance(now: number): string {
    if (now >= this.deadline) return (this.shown = this.target);
    const remaining = this.target.length - this.shown.length;
    const fraction = Math.max(0, now - this.lastTick) / Math.max(1, this.deadline - this.lastTick);
    let end = this.shown.length + Math.ceil(remaining * fraction);
    // Never render one half of a supplementary Unicode character.
    if (end > 0 && /[\uD800-\uDBFF]/u.test(this.target[end - 1]) && end < this.target.length) end += 1;
    this.shown = this.target.slice(0, end);
    this.lastTick = now;
    return this.shown;
  }

  get pending(): boolean { return this.shown !== this.target; }
}
