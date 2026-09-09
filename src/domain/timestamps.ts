declare const isoTimestampBrand: unique symbol;

export type IsoTimestamp = string & {
  readonly [isoTimestampBrand]: 'IsoTimestamp';
};

export function toIsoTimestamp(value: string): IsoTimestamp {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('Timestamp must be a canonical UTC ISO-8601 string');
  }

  return value as IsoTimestamp;
}

export function assertTimestampNotBefore(
  next: IsoTimestamp,
  previous: IsoTimestamp,
  field: string
): void {
  if (next < previous) {
    throw new TypeError(`${field} cannot move backwards`);
  }
}
