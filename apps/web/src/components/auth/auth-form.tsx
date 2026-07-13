import { useEffect, useRef, useState } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { INVITE_CODE_LENGTH } from "@repo/api/auth/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { OTPField, OTPFieldInput } from "@repo/ui/components/otp-field";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "@repo/ui/lib/utils";
import { useShake } from "@repo/ui/hooks/use-shake";
import { useMutation } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";
import { useTRPC } from "@/lib/trpc";

const OTP_SLOT_KEYS = Array.from({ length: INVITE_CODE_LENGTH }, (_, i) => `otp-slot-${i}`);

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
  const [code, setCode] = useState(() => defaultValue.toUpperCase().slice(0, INVITE_CODE_LENGTH));
  const autoSubmittedRef = useRef(false);
  const [error, setError] = useState(false);
  const [shakeScope, shake] = useShake();

  const validate = useMutation(
    trpc.auth.validateInvite.mutationOptions({
      onSuccess: (data) => onValidated(data.code),
      onError: (err) => {
        toast.error(err.message);
        setError(true);
        shake();
      },
    }),
  );

  const submit = (value: string) => {
    if (validate.isPending) return;
    validate.mutate({ code: value });
  };

  // Auto-submit when prefilled from the `?invite=` link so the user lands
  // straight on the email/password step without clicking through.
  useEffect(() => {
    if (autoSubmittedRef.current) return;
    if (code.length === INVITE_CODE_LENGTH) {
      autoSubmittedRef.current = true;
      submit(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === INVITE_CODE_LENGTH) submit(code);
      }}
    >
      <Field className="items-center gap-3">
        <FieldLabel className="sr-only" htmlFor="invite-code">
          Invite code
        </FieldLabel>
        <OTPField
          ref={shakeScope}
          id="invite-code"
          data-test="invite-code-input"
          className="justify-center"
          length={INVITE_CODE_LENGTH}
          validationType="alphanumeric"
          // Uppercase via the component's own normalizer. Doing it in
          // onValueChange instead breaks base-ui's focus advance: it compares
          // its pending-focus value against the controlled value, and a cased
          // mismatch ('d' vs 'D') silently cancels the focus move.
          normalizeValue={(value) => value.toUpperCase()}
          value={code}
          onValueChange={(value) => {
            setError(false);
            setCode(value);
          }}
          onValueComplete={(value) => submit(value)}
        >
          {OTP_SLOT_KEYS.map((slotKey, index) => (
            <OTPFieldInput
              key={slotKey}
              aria-label={`Character ${index + 1} of ${INVITE_CODE_LENGTH}`}
              aria-invalid={error}
            />
          ))}
        </OTPField>
      </Field>
    </form>
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
  const nextPath = search.nextPath ?? "/";

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
          router.navigate({ to: callbackUrl ?? nextPath, replace: true });
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
  const nextPath = search.nextPath ?? "/";
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
          router.navigate({ to: callbackUrl ?? nextPath, replace: true });
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
