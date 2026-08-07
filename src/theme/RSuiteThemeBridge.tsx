import type { ReactNode } from 'react';
import { CustomProvider } from 'rsuite';
import zhCN from 'rsuite/locales/zh_CN';
import { useTheme } from './useTheme';

interface RSuiteThemeBridgeProps {
  children: ReactNode;
}

/**
 * 把项目主题(resolvedTheme)桥接到 RSuite 的 CustomProvider。
 * CustomProvider 会据此在 <body> 上切换 rs-theme-light / rs-theme-dark,
 * 配合 styles/rsuite-bridge.css 将 --rs-* 对齐到 --uc-* 令牌。
 */
export function RSuiteThemeBridge({ children }: RSuiteThemeBridgeProps) {
  const { resolvedTheme } = useTheme();
  return (
    <CustomProvider locale={zhCN} theme={resolvedTheme}>
      {children}
    </CustomProvider>
  );
}
