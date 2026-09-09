import { useEffect, useRef, useState } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { INVITE_CODE_LENGTH } from "@repo/api/auth/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { OTPInput } from "@repo/ui/components/otp-input";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "cn";
import { BLUR_FADE } from "@repo/ui/lib/motion";
import { useShake } from "@repo/ui/hooks/use-shake";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";
import { useORPC } from "@/lib/orpc";

const DEFAULT_NEXT_PATH = "/home";

/**
 * Post-auth redirect targets arrive as free-form search params
 * (`?callbackUrl=`, `?nextPath=`), so constrain them to same-origin paths
 * before handing one to the router. The second character is the one that
 * matters: WHATWG URL parsing resolves both `//evil.example` and
 * `/\evil.example` to a cross-origin URL, so reject a slash *or* a backslash
 * there.
 */
const PROTOCOL_RELATIVE = /^\/[/\\]/u;

const safeNextPath = (path?: string): string =>
  path?.startsWith("/") && !PROTOCOL_RELATIVE.test(path) ? path : DEFAULT_NEXT_PATH;

type StepFormProps = { callbackUrl?: string } & React.HTMLAttributes<HTMLDivElement>;

/** The height change outlives the crossfade, so it gets a spring of its own. */
const STAGE_RESIZE = { bounce: 0, type: "spring" as const, visualDuration: 0.28 };

/**
 * A full code auto-verifies (covers both typing and the `?invite=` prefill);
 * wrong codes shake + clear inside `OTPInput`, and the message comes from the
 * query client's default mutation `onError` (lib/query-client.ts) — toasting
 * here too would double it. Resolving `verify` to the server's canonical code makes
 * `onSuccess` receive it directly.
 *
 * `verifying` brackets the round trip only — it clears the moment a verdict
 * lands, so nothing is still "loading" while the cells confirm.
 */
const InviteCodeStep = ({
  defaultValue,
  onValidated,
  onVerifyingChange,
}: {
  defaultValue: string;
  onValidated: (code: string) => void;
  onVerifyingChange: (verifying: boolean) => void;
}) => {
  const orpc = useORPC();
  const validate = useMutation(orpc.auth.validateInvite.mutationOptions());

  return (
    <Field className="items-center gap-3">
      <FieldLabel className="sr-only" htmlFor="invite-code">
        Invite code
      </FieldLabel>
      <OTPInput
        id="invite-code"
        data-test="invite-code-input"
        length={INVITE_CODE_LENGTH}
        validationType="alphanumeric"
        normalizeValue={(value) => value.toUpperCase()}
        defaultValue={defaultValue}
        group
        verify={(code) => {
          onVerifyingChange(true);
          return validate.mutateAsync({ code }).then(
            (data) => {
              onVerifyingChange(false);
              return data.code;
            },
            () => {
              onVerifyingChange(false);
              return false;
            },
          );
        }}
        onSuccess={onValidated}
      />
    </Field>
  );
};

interface Credentials {
  email: string;
  password: string;
}

/**
 * What a submit reports back, in the form's terms rather than the caller's.
 * `bounced` is the one that earns its place: the caller has already moved the
 * user somewhere else (register kicks a raced invite back to step 1), so the
 * form must toast WITHOUT shaking — shaking a panel that is sliding away
 * fights the step transition.
 */
type SubmitResult =
  | { status: "ok" }
  | { status: "failed"; message: string }
  | { status: "bounced"; message: string };

/**
 * better-auth reports through `fetchOptions` callbacks rather than its return
 * value, so a submit starts out failed and is upgraded by `onSuccess`. The
 * form then navigates only on a success it actually saw — never merely on the
 * absence of an error.
 */
const UNREPORTED: SubmitResult = {
  message: "Something went wrong. Please try again.",
  status: "failed",
};

/**
 * Email + password, shared by login and register. Identical fields, identical
 * error treatment (toast, shake, invalid until the next keystroke) and the
 * same post-auth redirect; the caller supplies only what actually differs —
 * the auth call, the button label, and which password the browser should
 * offer.
 */
const CredentialsForm = ({
  submit,
  submitLabel,
  passwordAutoComplete,
  callbackUrl,
}: {
  submit: (credentials: Credentials) => Promise<SubmitResult>;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
  callbackUrl?: string;
}) => {
  const router = useRouter();
  const search = useSearch({ from: "/auth" });
  const nextPath = safeNextPath(search.nextPath);
  const [authError, setAuthError] = useState(false);
  const [shakeScope, shake] = useShake();

  const form = useForm({
    defaultValues: { email: "", password: "" },
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(1, "Password is required"),
      }),
    ),
  });

  const handleAuthWithPassword = form.handleSubmit(async (credentials) => {
    const result = await submit(credentials);
    if (result.status === "ok") {
      router.navigate({ replace: true, to: safeNextPath(callbackUrl ?? nextPath) });
      return;
    }
    toast.error(result.message);
    if (result.status === "bounced") {
      return;
    }
    setAuthError(true);
    shake();
  });

  return (
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
                  autoComplete={passwordAutoComplete}
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
        {submitLabel}
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
}) => (
  <CredentialsForm
    submitLabel="Register"
    passwordAutoComplete="new-password"
    callbackUrl={callbackUrl}
    submit={async (credentials) => {
      const [emailPrefix] = credentials.email.split("@");
      let result: SubmitResult = UNREPORTED;
      // SAFETY: `inviteCode` is an extra body field consumed by the server-side
      // `user.create.before` hook to validate + atomically redeem the invite.
      // It isn't part of better-auth's typed signup payload, so we cast.
      await authClient.signUp.email({
        email: credentials.email,
        fetchOptions: {
          onError: (ctx) => {
            // The atomic claim happens at signup; if the code raced and lost
            // (or was revoked between steps), kick the user back to step 1.
            const raced = ctx.error.status === 403 || ctx.error.status === 409;
            if (raced) {
              onChangeCode();
            }
            result = { message: ctx.error.message, status: raced ? "bounced" : "failed" };
          },
          onSuccess: () => {
            result = { status: "ok" };
          },
        },
        inviteCode,
        name: emailPrefix ?? "User",
        password: credentials.password,
      } as Parameters<typeof authClient.signUp.email>[0]);
      return result;
    }}
  />
);

/**
 * Controlled two-step register flow. The parent owns `verifiedCode` so it can
 * drive surrounding UI (e.g. the header subtitle): `null` = invite step, a
 * code = credentials step.
 *
 * The stage animates its REAL height between the one-row invite step and the
 * taller credentials step. Motion's `layout` prop is the obvious tool and the
 * wrong one here: it fakes the resize with a transform, so the element's
 * layout box still jumps in a single frame and everything around it — heading
 * above, footer below — snaps to the new position while the stage merely looks
 * smooth. Measuring the content and animating `height` moves the page as one.
 */
export const RegisterForm = ({
  className,
  callbackUrl,
  verifiedCode,
  onVerifiedCodeChange,
  onVerifyingChange,
  ...props
}: StepFormProps & {
  verifiedCode: string | null;
  onVerifiedCodeChange: (code: string | null) => void;
  /** Reports the invite round-trip so the page can swap its footer for a spinner. */
  onVerifyingChange: (verifying: boolean) => void;
}) => {
  const search = useSearch({ from: "/auth" });
  const contentRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState<number | "auto">("auto");

  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (entry) {
        setStageHeight(entry.contentRect.height);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      <MotionConfig reducedMotion="user">
        <motion.div initial={false} animate={{ height: stageHeight }} transition={STAGE_RESIZE}>
          <div ref={contentRef} className="grid">
            <AnimatePresence mode="popLayout" initial={false}>
              {verifiedCode ? (
                <motion.div key="credentials" {...BLUR_FADE}>
                  <RegisterCredentialsStep
                    inviteCode={verifiedCode}
                    callbackUrl={callbackUrl}
                    onChangeCode={() => onVerifiedCodeChange(null)}
                  />
                </motion.div>
              ) : (
                <motion.div key="invite" {...BLUR_FADE}>
                  <InviteCodeStep
                    defaultValue={search.invite ?? ""}
                    onValidated={(code) => onVerifiedCodeChange(code)}
                    onVerifyingChange={onVerifyingChange}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </MotionConfig>
    </div>
  );
};

export const LoginForm = ({ className, callbackUrl, ...props }: StepFormProps) => (
  <div className={cn("grid gap-6", className)} {...props}>
    <CredentialsForm
      submitLabel="Login"
      passwordAutoComplete="current-password"
      callbackUrl={callbackUrl}
      submit={async (credentials) => {
        let result: SubmitResult = UNREPORTED;
        await authClient.signIn.email({
          email: credentials.email,
          fetchOptions: {
            onError: (ctx) => {
              result = { message: ctx.error.message, status: "failed" };
            },
            onSuccess: () => {
              result = { status: "ok" };
            },
          },
          password: credentials.password,
        });
        return result;
      }}
    />
  </div>
);

export const RequestPasswordResetForm = () => {
  const form = useForm({
    defaultValues: {
      email: "",
    },
    resolver: zodResolver(
      z.object({
        email: z.email("Invalid email address"),
      }),
    ),
  });

  const handlePasswordReset = form.handleSubmit(async (data) => {
    await authClient.requestPasswordReset({
      email: data.email,
      fetchOptions: {
        onError: (ctx) => {
          toast.error(ctx.error.message);
        },
        onSuccess: () => {
          toast.success("Password reset email sent successfully!");
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
    defaultValues: {
      confirmPassword: "",
      password: "",
    },
    resolver: zodResolver(
      z
        .object({
          confirmPassword: z.string(),
          password: z.string().min(8, "Password must be at least 8 characters"),
        })
        .refine((data) => data.password === data.confirmPassword, {
          message: "Passwords don't match",
          path: ["confirmPassword"],
        }),
    ),
  });

  const handleUpdatePassword = form.handleSubmit(async (data) => {
    await authClient.resetPassword({
      fetchOptions: {
        onError: (ctx) => {
          toast.error(ctx.error.message);
        },
        onSuccess: () => {
          toast.success("Password updated successfully!");
          updateRouter.navigate({ to: "/" });
        },
      },
      newPassword: data.password,
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
