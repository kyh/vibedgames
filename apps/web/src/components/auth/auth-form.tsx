import { useState } from "react";
import { getRouteApi, useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "cn";
import { useShake } from "@repo/ui/hooks/use-shake";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";

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

/**
 * True while a connecting app's OAuth flow sent this person here: the page
 * carries the provider's signed authorize query. A sign-in then answers with
 * where the flow goes next and the auth client follows it, so the form must
 * not navigate on its own.
 */
const inOAuthFlow = (): boolean =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("sig");

type StepFormProps = { callbackUrl?: string } & React.HTMLAttributes<HTMLDivElement>;

interface Credentials {
  email: string;
  password: string;
}

/** What a submit reports back, in the form's terms rather than the caller's. */
type SubmitResult = { status: "ok" } | { status: "failed"; message: string };

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
      if (inOAuthFlow()) {
        return;
      }
      // `href`, not `to`: a callback carries its own query and hash
      // (`/auth/cli?code=…`, `/settings?code=…#credits`), which `to` reads as path.
      router.navigate({ href: safeNextPath(callbackUrl ?? nextPath), replace: true });
      return;
    }
    toast.error(result.message);
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

const PROVIDER_LABELS = { github: "GitHub", google: "Google" } as const;

const authRoute = getRouteApi("/auth");

/**
 * One button per social provider this deployment has credentials for. The
 * provider's callback lands on the same destination the password form would;
 * in an OAuth flow the auth client carries the signed query along, and the
 * provider resumes the flow once the callback signs the person in (its
 * redirect to consent wins over `callbackURL`). A failed callback comes back
 * to this same page with its query (an OAuth flow's signed query, a
 * `callbackUrl`, an `invite`), so the person can try again where they were.
 */
const SocialSignIn = ({ callbackUrl }: { callbackUrl?: string }) => {
  const { socialProviders } = authRoute.useLoaderData();
  const search = authRoute.useSearch();
  const [pending, setPending] = useState<string | null>(null);
  if (socialProviders.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-2">
      {socialProviders.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          loading={pending === provider}
          disabled={pending !== null}
          onClick={async () => {
            setPending(provider);
            await authClient.signIn.social({
              callbackURL: safeNextPath(callbackUrl ?? search.nextPath),
              errorCallbackURL: `${window.location.pathname}${window.location.search}`,
              fetchOptions: {
                onError: (ctx) => {
                  toast.error(ctx.error.message);
                  setPending(null);
                },
              },
              provider,
            });
          }}
        >
          Continue with {PROVIDER_LABELS[provider]}
        </Button>
      ))}
      <p className="text-muted-foreground text-center text-xs">or</p>
    </div>
  );
};

/**
 * Where a person lands after signing in or up with a credit code in the link
 * (`?invite=`, the name links minted before launch carry): the settings page,
 * whose redeem field picks the code up. A sign-in with no code keeps its own
 * destination.
 */
export const creditCodeCallback = (code?: string): string | undefined =>
  code ? `/settings?code=${encodeURIComponent(code)}#credits` : undefined;

export const RegisterForm = ({ className, callbackUrl, ...props }: StepFormProps) => (
  <div className={cn("grid gap-6", className)} {...props}>
    <SocialSignIn callbackUrl={callbackUrl} />
    <CredentialsForm
      submitLabel="Register"
      passwordAutoComplete="new-password"
      callbackUrl={callbackUrl}
      submit={async (credentials) => {
        const [emailPrefix] = credentials.email.split("@");
        let result: SubmitResult = UNREPORTED;
        await authClient.signUp.email({
          email: credentials.email,
          fetchOptions: {
            onError: (ctx) => {
              result = { message: ctx.error.message, status: "failed" };
            },
            onSuccess: () => {
              result = { status: "ok" };
            },
          },
          name: emailPrefix ?? "User",
          password: credentials.password,
        });
        return result;
      }}
    />
  </div>
);

export const LoginForm = ({ className, callbackUrl, ...props }: StepFormProps) => (
  <div className={cn("grid gap-6", className)} {...props}>
    <SocialSignIn callbackUrl={callbackUrl} />
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
