import { forwardRef } from 'react';
import { Button as RSuiteButton } from 'rsuite';
import type { ButtonProps as RSuiteButtonProps } from 'rsuite';
import '../styles/components.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const appearanceByVariant: Record<ButtonVariant, RSuiteButtonProps['appearance']> = {
  primary: 'primary',
  secondary: 'default',
  ghost: 'subtle'
};

export interface ButtonProps extends Omit<RSuiteButtonProps, 'appearance'> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', type = 'button', variant = 'primary', ...props },
  ref
) {
  const classes = ['uc-button', `uc-button--${variant}`, className].filter(Boolean).join(' ');
  return (
    <RSuiteButton
      appearance={appearanceByVariant[variant]}
      className={classes}
      ref={ref}
      type={type}
      {...props}
    />
  );
});
