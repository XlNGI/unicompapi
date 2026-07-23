import type { ImageWorkspaceInputDto } from '../../../shared/image-workspace-ipc';

export type ImageRegion = NonNullable<ImageWorkspaceInputDto['region']>;

export function ImageRegionFields({
  disabled,
  label = '启用区域选择（不勾选时使用全图）',
  region,
  onChange
}: {
  readonly disabled?: boolean;
  readonly label?: string;
  readonly region?: ImageRegion;
  readonly onChange: (region: ImageRegion | undefined) => void;
}) {
  function changeField(
    key: 'x' | 'y' | 'width' | 'height',
    percent: number
  ) {
    if (!region || !Number.isFinite(percent)) return;
    const next = { ...region };
    const minimum = key === 'width' || key === 'height' ? 0.01 : 0;
    const maximum = key === 'x' || key === 'y' ? 0.99 : 1;
    next[key] = Math.min(maximum, Math.max(minimum, percent / 100));
    next.width = Math.min(next.width, 1 - next.x);
    next.height = Math.min(next.height, 1 - next.y);
    onChange(next);
  }

  return (
    <>
      <label className="uc-image-quick__checkbox">
        <input
          checked={Boolean(region)}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { x: 0, y: 0, width: 1, height: 1 }
                : undefined
            )
          }
          type="checkbox"
        />
        <span>{label}</span>
      </label>
      {region ? (
        <div
          aria-label="图片区域百分比"
          className="uc-image-understanding__region-fields"
        >
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label className="uc-image-quick__field" key={key}>
              <span>
                {key === 'x'
                  ? '左侧'
                  : key === 'y'
                    ? '顶部'
                    : key === 'width'
                      ? '宽度'
                      : '高度'}
                （%）
              </span>
              <input
                max={key === 'x' || key === 'y' ? 99 : 100}
                min={key === 'width' || key === 'height' ? 1 : 0}
                onChange={(event) =>
                  changeField(key, Number(event.target.value))
                }
                type="number"
                value={Math.round(region[key] * 100)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}
