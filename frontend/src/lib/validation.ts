import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254, "Email address is too long.");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const recoverySchema = z.object({ email: emailSchema });

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .regex(/[a-z]/, "Include a lowercase letter.")
  .regex(/[A-Z]/, "Include an uppercase letter.")
  .regex(/[0-9]/, "Include a number.");

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm your new password."),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });

export const totpSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

export type SignInValues = z.infer<typeof signInSchema>;
export type RecoveryValues = z.infer<typeof recoverySchema>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;
export type TotpValues = z.infer<typeof totpSchema>;
