import { useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "@repo/ui/lib/utils";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";

type AuthFormProps = {
  type: "login" | "register";
  callbackUrl?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export const AuthForm = ({ className, type, callbackUrl, ...props }: AuthFormProps) => {
  const router = useRouter();
  const search = useSearch({ from: "/auth" });
  const nextPath = search.nextPath ?? "/";

  const form = useForm({
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
      }),
    ),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const handleAuthWithPassword = form.handleSubmit(async (credentials) => {
    if (type === "register") {
      const emailPrefix = credentials.email.split("@")[0];
      await authClient.signUp.email({
        email: credentials.email,
        password: credentials.password,
        name: emailPrefix ?? "User",
        fetchOptions: {
          onSuccess: () => {
            router.navigate({ to: callbackUrl ?? nextPath, replace: true });
          },
          onError: (ctx) => {
            toast.error(ctx.error.message);
          },
        },
      });
    }

    if (type === "login") {
      await authClient.signIn.email({
        email: credentials.email,
        password: credentials.password,
        fetchOptions: {
          onSuccess: () => {
            router.navigate({ to: callbackUrl ?? nextPath, replace: true });
          },
          onError: (ctx) => {
            toast.error(ctx.error.message);
          },
        },
      });
    }
  });

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      <form className="grid gap-2" onSubmit={handleAuthWithPassword}>
        <FieldGroup className="gap-2">
          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error} className="gap-1">
                <FieldLabel className="sr-only" htmlFor="email">
                  Email
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="email"
                    data-test="email-input"
                    aria-invalid={!!fieldState.error}
                    required
                    type="email"
                    placeholder="name@example.com"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect="off"
                    {...field}
                  />
                </FieldContent>
                {fieldState.error && <FieldError>{fieldState.error.message}</FieldError>}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error} className="gap-1">
                <FieldLabel className="sr-only" htmlFor="password">
                  Password
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="password"
                    data-test="password-input"
                    aria-invalid={!!fieldState.error}
                    required
                    type="password"
                    placeholder="******"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    autoCorrect="off"
                    {...field}
                  />
                </FieldContent>
                {fieldState.error && <FieldError>{fieldState.error.message}</FieldError>}
              </Field>
            )}
          />
        </FieldGroup>
        <Button loading={form.formState.isSubmitting}>
          {type === "login" ? "Login" : "Register"}
        </Button>
      </form>
    </div>
  );
};

export const RequestPasswordResetForm = () => {
  const form = useForm({
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
      }),
    ),
    defaultValues: {
      email: "",
    },
  });

  const handlePasswordReset = form.handleSubmit(async (data) => {
    await authClient.requestPasswordReset({
      email: data.email,
      fetchOptions: {
        onSuccess: () => {
          toast.success("Password reset email sent successfully!");
        },
        onError: (ctx) => {
          toast.error(ctx.error.message);
        },
      },
    });
  });

  if (form.formState.isSubmitSuccessful) {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-md bg-green-900/20 p-4">
          <p className="text-sm text-green-200">
            Password reset email sent! Check your inbox and follow the instructions to reset your
            password.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={handlePasswordReset}>
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error} className="gap-1">
              <FieldLabel className="sr-only" htmlFor="reset-email">
                Email
              </FieldLabel>
              <FieldContent>
                <Input
                  id="reset-email"
                  aria-invalid={!!fieldState.error}
                  required
                  type="email"
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  {...field}
                />
              </FieldContent>
              {fieldState.error && <FieldError>{fieldState.error.message}</FieldError>}
            </Field>
          )}
        />
      </FieldGroup>
      <Button loading={form.formState.isSubmitting}>Request Password Reset</Button>
    </form>
  );
};

export const UpdatePasswordForm = () => {
  const updateRouter = useRouter();

  const form = useForm({
    resolver: zodResolver(
      z
        .object({
          password: z.string().min(8, "Password must be at least 8 characters"),
          confirmPassword: z.string(),
        })
        .refine((data) => data.password === data.confirmPassword, {
          message: "Passwords don't match",
          path: ["confirmPassword"],
        }),
    ),
    defaultValues: {
      password: "",
      confirmPassword: "",
    },
  });

  const handleUpdatePassword = form.handleSubmit(async (data) => {
    await authClient.resetPassword({
      newPassword: data.password,
      fetchOptions: {
        onSuccess: () => {
          toast.success("Password updated successfully!");
          updateRouter.navigate({ to: "/" });
        },
        onError: (ctx) => {
          toast.error(ctx.error.message);
        },
      },
    });
  });

  return (
    <form className="grid gap-4" onSubmit={handleUpdatePassword}>
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error} className="gap-1">
              <FieldLabel className="sr-only" htmlFor="new-password">
                New Password
              </FieldLabel>
              <FieldContent>
                <Input
                  id="new-password"
                  aria-invalid={!!fieldState.error}
                  required
                  type="password"
                  placeholder="Enter new password"
                  autoCapitalize="none"
                  autoComplete="new-password"
                  autoCorrect="off"
                  {...field}
                />
              </FieldContent>
              {fieldState.error && <FieldError>{fieldState.error.message}</FieldError>}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error} className="gap-1">
              <FieldLabel className="sr-only" htmlFor="confirm-password">
                Confirm New Password
              </FieldLabel>
              <FieldContent>
                <Input
                  id="confirm-password"
                  aria-invalid={!!fieldState.error}
                  required
                  type="password"
                  placeholder="Confirm new password"
                  autoCapitalize="none"
                  autoComplete="new-password"
                  autoCorrect="off"
                  {...field}
                />
              </FieldContent>
              {fieldState.error && <FieldError>{fieldState.error.message}</FieldError>}
            </Field>
          )}
        />
      </FieldGroup>
      <Button loading={form.formState.isSubmitting}>Update Password</Button>
    </form>
  );
};
