import { useState } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { INVITE_CODE_LENGTH } from "@repo/api/auth/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { OTPInput } from "@repo/ui/components/otp-input";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "@repo/ui/lib/utils";
import { useShake } from "@repo/ui/hooks/use-shake";
import { useMutation } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";
import { useTRPC } from "@/lib/trpc";

const DEFAULT_NEXT_PATH = "/home";

/**
 * Post-auth redirect targets arrive as free-form search params
 * (`?callbackUrl=`, `?nextPath=`), so constrain them to same-origin paths
 * before handing one to the router. The second character is the one that
 * matters: WHATWG URL parsing resolves both `//evil.example` and
 * `/\evil.example` to a cross-origin URL, so reject a slash *or* a backslash
 * there.
 */
const PROTOCOL_RELATIVE = /^\/[/\\]/;

const safeNextPath = (path?: string): string =>
  path?.startsWith("/") && !PROTOCOL_RELATIVE.test(path) ? path : DEFAULT_NEXT_PATH;

type StepFormProps = { callbackUrl?: string } & React.HTMLAttributes<HTMLDivElement>;

/**
 * Controlled two-step register flow. The parent owns `verifiedCode` so it can
 * drive surrounding UI (e.g. hide the invite-required header once verified):
 * `null` = invite step, a code = credentials step.
 */
export const RegisterForm = ({
  className,
  callbackUrl,
  verifiedCode,
  onVerifiedCodeChange,
  ...props
}: StepFormProps & {
  verifiedCode: string | null;
  onVerifiedCodeChange: (code: string | null) => void;
}) => {
  const search = useSearch({ from: "/auth" });

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      {verifiedCode ? (
        <RegisterCredentialsStep
          inviteCode={verifiedCode}
          callbackUrl={callbackUrl}
          onChangeCode={() => onVerifiedCodeChange(null)}
        />
      ) : (
        <InviteCodeStep
          defaultValue={search.invite ?? ""}
          onValidated={(code) => onVerifiedCodeChange(code)}
        />
      )}
    </div>
  );
};

const InviteCodeStep = ({
  defaultValue,
  onValidated,
}: {
  defaultValue: string;
  onValidated: (code: string) => void;
}) => {
  const trpc = useTRPC();
  const validate = useMutation(trpc.auth.validateInvite.mutationOptions());

  return (
    <Field className="items-center gap-3">
      <FieldLabel className="sr-only" htmlFor="invite-code">
        Invite code
      </FieldLabel>
      {/* A full code auto-verifies (covers both typing and the `?invite=`
          prefill); wrong codes shake + clear inside the component, so the
          only error surface here is the toast. Resolving `verify` to the
          server's canonical code makes `onSuccess` receive it directly. */}
      <OTPInput
        id="invite-code"
        data-test="invite-code-input"
        length={INVITE_CODE_LENGTH}
        validationType="alphanumeric"
        normalizeValue={(value) => value.toUpperCase()}
        defaultValue={defaultValue}
        group
        verify={(code) =>
          validate.mutateAsync({ code }).then(
            (data) => data.code,
            (err: unknown) => {
              toast.error(err instanceof Error ? err.message : "Invalid invite code");
              return false;
            },
          )
        }
        onSuccess={onValidated}
      />
    </Field>
  );
};

const RegisterCredentialsStep = ({
  inviteCode,
  callbackUrl,
  onChangeCode,
}: {
  inviteCode: string;
  callbackUrl?: string;
  onChangeCode: () => void;
}) => {
  const router = useRouter();
  const search = useSearch({ from: "/auth" });
  const nextPath = safeNextPath(search.nextPath);

  const form = useForm({
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
      }),
    ),
    defaultValues: { email: "", password: "" },
  });

  const handleAuthWithPassword = form.handleSubmit(async (credentials) => {
    const emailPrefix = credentials.email.split("@")[0];
    // `inviteCode` is an extra body field consumed by the server-side
    // `user.create.before` hook to validate + atomically redeem the invite.
    // It isn't part of better-auth's typed signup payload, so we cast.
    await authClient.signUp.email({
      email: credentials.email,
      password: credentials.password,
      name: emailPrefix ?? "User",
      inviteCode,
      fetchOptions: {
        onSuccess: () => {
          router.navigate({ to: safeNextPath(callbackUrl ?? nextPath), replace: true });
        },
        onError: (ctx) => {
          // The atomic claim happens at signup; if the code raced and lost
          // (or was revoked between steps), kick the user back to step 1.
          if (ctx.error.status === 403 || ctx.error.status === 409) {
            onChangeCode();
          }
          toast.error(ctx.error.message);
        },
      },
    } as Parameters<typeof authClient.signUp.email>[0]);
  });

  return (
    <form className="grid gap-2" onSubmit={handleAuthWithPassword}>
      <p className="text-muted-foreground text-center text-sm">
        Invite code <span className="text-foreground font-mono">{inviteCode}</span> verified.{" "}
        <button type="button" onClick={onChangeCode} className="underline">
          Change
        </button>
      </p>
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
              <FieldError>{fieldState.error?.message}</FieldError>
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
                  autoComplete="new-password"
                  autoCorrect="off"
                  {...field}
                />
              </FieldContent>
              <FieldError>{fieldState.error?.message}</FieldError>
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" loading={form.formState.isSubmitting}>
        Register
      </Button>
    </form>
  );
};

export const LoginForm = ({ className, callbackUrl, ...props }: StepFormProps) => {
  const router = useRouter();
  const search = useSearch({ from: "/auth" });
  const nextPath = safeNextPath(search.nextPath);
  const [authError, setAuthError] = useState(false);
  const [shakeScope, shake] = useShake();

  const form = useForm({
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
      }),
    ),
    defaultValues: { email: "", password: "" },
  });

  const handleAuthWithPassword = form.handleSubmit(async (credentials) => {
    await authClient.signIn.email({
      email: credentials.email,
      password: credentials.password,
      fetchOptions: {
        onSuccess: () => {
          router.navigate({ to: safeNextPath(callbackUrl ?? nextPath), replace: true });
        },
        onError: (ctx) => {
          toast.error(ctx.error.message);
          setAuthError(true);
          shake();
        },
      },
    });
  });

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      <form ref={shakeScope} className="grid gap-2" onSubmit={handleAuthWithPassword}>
        <FieldGroup className="gap-2">
          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error || authError} className="gap-1">
                <FieldLabel className="sr-only" htmlFor="email">
                  Email
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="email"
                    data-test="email-input"
                    aria-invalid={!!fieldState.error || authError}
                    required
                    type="email"
                    placeholder="name@example.com"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect="off"
                    variant="frosted"
                    {...field}
                    onChange={(e) => {
                      setAuthError(false);
                      field.onChange(e);
                    }}
                  />
                </FieldContent>
                <FieldError>{fieldState.error?.message}</FieldError>
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error || authError} className="gap-1">
                <FieldLabel className="sr-only" htmlFor="password">
                  Password
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="password"
                    data-test="password-input"
                    aria-invalid={!!fieldState.error || authError}
                    required
                    type="password"
                    placeholder="******"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    autoCorrect="off"
                    variant="frosted"
                    {...field}
                    onChange={(e) => {
                      setAuthError(false);
                      field.onChange(e);
                    }}
                  />
                </FieldContent>
                <FieldError>{fieldState.error?.message}</FieldError>
              </Field>
            )}
          />
        </FieldGroup>
        <Button type="submit" loading={form.formState.isSubmitting}>
          Login
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
      <Button type="submit" loading={form.formState.isSubmitting}>
        Request Password Reset
      </Button>
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
      <Button type="submit" loading={form.formState.isSubmitting}>
        Update Password
      </Button>
    </form>
  );
};
