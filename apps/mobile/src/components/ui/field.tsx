import type { ReactNode } from "react";
import { View, type TextInputProps } from "react-native";
import { Description, FieldError, Input, Label, TextField } from "heroui-native";

import { cn } from "@/lib/cn";

export function Field({
  label,
  description,
  error,
  required = false,
  disabled = false,
  prefix,
  suffix,
  className,
  ...inputProps
}: Omit<TextInputProps, "className"> & {
  label: string;
  description?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  className?: string;
}) {
  return (
    <TextField isRequired={required} isDisabled={disabled} isInvalid={Boolean(error)}>
      <Label className="font-medium">{label}</Label>
      <View className="flex-row items-center">
        {prefix ? <View className="absolute left-3 z-10">{prefix}</View> : null}
        <Input
          {...inputProps}
          className={cn("min-h-11 flex-1 rounded-md", prefix && "pl-11!", suffix && "pr-11!", className)}
        />
        {suffix ? <View className="absolute right-3 z-10">{suffix}</View> : null}
      </View>
      {description && !error ? <Description>{description}</Description> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </TextField>
  );
}
