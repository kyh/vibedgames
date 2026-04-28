import { useEffect, useRef, useState } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { OTPField, OTPFieldInput } from "@repo/ui/components/otp-field";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "@repo/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";
import { useTRPC } from "@/lib/trpc";

const INVITE_CODE_LENGTH = 6;
const OTP_SLOT_KEYS = Array.from({ length: INVITE_CODE_LENGTH }, (_, i) => `otp-slot-${i}`);

type AuthFormProps = {
  type: "login" | "register";
  callbackUrl?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export const AuthForm = ({ className, type, callbackUrl, ...props }: AuthFormProps) => {
  if (type === "register") {
    return <RegisterForm className={className} callbackUrl={callbackUrl} {...props} />;
  }
  return <LoginForm className={className} callbackUrl={callbackUrl} {...props} />;
};

type StepFormProps = { callbackUrl?: string } & React.HTMLAttributes<HTMLDivElement>;

const RegisterForm = ({ className, callbackUrl, ...props }: StepFormProps) => {
  const search = useSearch({ from: "/auth" });
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      {verifiedCode ? (
        <RegisterCredentialsStep
          inviteCode={verifiedCode}
          callbackUrl={callbackUrl}
          onChangeCode={() => setVerifiedCode(null)}
        />
      ) : (
        <InviteCodeStep
          defaultValue={search.invite ?? ""}
          onValidated={(code) => setVerifiedCode(code)}
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
  const [code, setCode] = useState(defaultValue.toUpperCase().slice(0, INVITE_CODE_LENGTH));
  const [error, setError] = useState<string | null>(null);
  const autoSubmittedRef = useRef(false);

  const validate = useMutation(
    trpc.invite.validate.mutationOptions({
      onSuccess: (data) => onValidated(data.code),
      onError: (err) => setError(err.message),
    }),
  );

  const submit = (value: string) => {
    if (validate.isPending) return;
    setError(null);
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
          id="invite-code"
          data-test="invite-code-input"
          length={INVITE_CODE_LENGTH}
          validationType="alphanumeric"
          value={code}
          onValueChange={(value) => {
            setError(null);
            setCode(value.toUpperCase());
          }}
          onValueComplete={(value) => submit(value.toUpperCase())}
          disabled={validate.isPending}
        >
          {OTP_SLOT_KEYS.map((slotKey, index) => (
            <OTPFieldInput
              key={slotKey}
              aria-label={`Character ${index + 1} of ${INVITE_CODE_LENGTH}`}
              aria-invalid={!!error}
            />
          ))}
        </OTPField>
        {error ? <FieldError className="text-center">{error}</FieldError> : null}
      </Field>
      <Button
        type="submit"
        loading={validate.isPending}
        disabled={code.length !== INVITE_CODE_LENGTH}
      >
        Continue
      </Button>
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
                  className="bg-input/40 backdrop-blur-sm"
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
                  className="bg-input/40 backdrop-blur-sm"
                  {...field}
                />
              </FieldContent>
              <FieldError>{fieldState.error?.message}</FieldError>
            </Field>
          )}
        />
      </FieldGroup>
      <Button loading={form.formState.isSubmitting}>Register</Button>
    </form>
  );
};

const LoginForm = ({ className, callbackUrl, ...props }: StepFormProps) => {
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
                    className="bg-input/40 backdrop-blur-sm"
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
                    autoComplete="current-password"
                    autoCorrect="off"
                    className="bg-input/40 backdrop-blur-sm"
                    {...field}
                  />
                </FieldContent>
                <FieldError>{fieldState.error?.message}</FieldError>
              </Field>
            )}
          />
        </FieldGroup>
        <Button loading={form.formState.isSubmitting}>Login</Button>
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
                  className="bg-input/40 backdrop-blur-sm"
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
                  className="bg-input/40 backdrop-blur-sm"
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
                  className="bg-input/40 backdrop-blur-sm"
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
