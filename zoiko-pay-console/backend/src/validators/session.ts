import { z } from "zod";

export const loginBody = z
  .object({
    username: z.string().trim().min(1, "Enter your username").max(120),
    password: z.string().min(1, "Enter your password").max(256),
  })
  .strict();

export const environmentBody = z.object({ environment: z.enum(["TEST", "LIVE"]) }).strict();

export const overviewQuery = z.object({
  period: z.enum(["24h", "7d", "30d"]).default("7d"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("GBP"),
  merchantId: z.string().regex(/^mer_[a-z0-9_]{1,60}$/).optional(),
});

/** Same rule as the Keycloak realm policy, checked here first for a clear message. */
export const password = z.string().min(8, "At least 8 characters").max(128)
  .regex(/[A-Z]/, "Needs an upper-case letter").regex(/[a-z]/, "Needs a lower-case letter")
  .regex(/\d/, "Needs a digit").regex(/[^A-Za-z0-9]/, "Needs a symbol");

export const registerBody = z
  .object({
    username: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,39}$/, "3–40 characters: letters, digits, '.', '_' or '-', starting with a letter"),
    firstName: z.string().trim().min(1, "Enter your first name").max(60),
    lastName: z.string().trim().min(1, "Enter your last name").max(60),
    email: z.email("Enter a valid email").max(120),
    password,
  })
  .strict()
  .refine((b) => !b.password.toLowerCase().includes(b.username), { message: "Password must not contain your username", path: ["password"] });

export const changePasswordBody = z
  .object({
    username: z.string().trim().min(1).max(120),
    currentPassword: z.string().min(1, "Enter your current password").max(256),
    newPassword: password,
  })
  .strict()
  .refine((b) => b.newPassword !== b.currentPassword, { message: "Choose a different password", path: ["newPassword"] });
