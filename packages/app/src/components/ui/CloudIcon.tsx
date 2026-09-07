import type { SVGProps } from "react";

/**
 * 安卓同款 CloudIcon:
 * 纯线框、圆润描边、与 packages/app-expo/src/components/ui/Icon.tsx 100% 对齐
 */
export function CloudIcon({
  className = "",
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}
