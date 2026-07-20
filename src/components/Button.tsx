import type { ButtonHTMLAttributes } from 'react';
import '../styles/components.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ className = '', type = 'button', variant = 'primary', ...props }: ButtonProps) {
  const classes = ['uc-button', `uc-button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} type={type} {...props} />;
}
