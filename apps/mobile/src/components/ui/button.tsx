import type { ReactNode } from "react";
import { Button as HeroButton, Spinner } from "heroui-native";

import { cn } from "@/lib/cn";

export function Button({
  children,
  onPress,
  tone = "primary",
  size = "md",
  loading = false,
  disabled = false,
  className,
  prefix,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  tone?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  prefix?: ReactNode;
  accessibilityLabel?: string;
}) {
  const variant = tone === "primary"
    ? "primary"
    : tone === "secondary"
      ? "outline"
      : tone === "danger"
        ? "danger"
        : "tertiary";
  return (
    <HeroButton
      variant={variant}
      size={size}
      isDisabled={disabled || loading}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      className={cn("rounded-md", className)}
    >
      {loading ? <Spinner size="sm" /> : prefix}
      <HeroButton.Label className="font-semibold">{children}</HeroButton.Label>
    </HeroButton>
  );
}
