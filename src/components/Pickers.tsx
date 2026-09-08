import { forwardRef, type ComponentProps, type ComponentRef } from 'react';
import { DateRangePicker as RSDateRangePicker, SelectPicker as RSSelectPicker, type DateRangePickerProps } from 'rsuite';

const container = () => document.getElementById('uc-picker-layer') ?? document.body;

// RSuite 6.2 forwards overlay props from raw props, bypassing CustomProvider defaults.
export const SelectPicker = forwardRef<ComponentRef<typeof RSSelectPicker>, ComponentProps<typeof RSSelectPicker>>(
  (props, ref) => <RSSelectPicker container={container} preventOverflow placement="autoVerticalStart" {...props} ref={ref} />
) as typeof RSSelectPicker;
SelectPicker.displayName = 'SelectPicker';

export const DateRangePicker = forwardRef<ComponentRef<typeof RSDateRangePicker>, DateRangePickerProps>(
  (props, ref) => <RSDateRangePicker container={container} preventOverflow placement="autoVerticalEnd" {...props} ref={ref} />
);
DateRangePicker.displayName = 'DateRangePicker';
