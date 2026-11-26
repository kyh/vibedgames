import { useState } from "react";
import { getRouteApi, useHydrated, useRouter, useSearch } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { OTPInput } from "@repo/ui/components/otp-input";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "cn";
import { useShake } from "@repo/ui/hooks/use-shake";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/auth/client";
import { codeErrorMessage, SIGN_IN_CODE_LENGTH } from "@/auth/sign-in-code";

const DEFAULT_NEXT_PATH = "/home";

const PROTOCOL_RELATIVE = /^\/[/\\]/u;

const safeNextPath = (path?: string) =>
  path?.startsWith("/") === true && !PROTOCOL_RELATIVE.test(path) ? path : DEFAULT_NEXT_PATH;

const inOAuthFlow = () =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("sig");

type AuthFormProps = { callbackUrl?: string } & React.HTMLAttributes<HTMLDivElement>;

const HydratedForm = ({ children, ...props }: Omit<React.ComponentProps<"form">, "method">) => {
  const hydrated = useHydrated();

  return (
    <form method="post" {...props}>
      <fieldset disabled={!hydrated} className="contents">
        {children}
      </fieldset>
    </form>
  );
};

const sendSignInCode = async (email: string) => {
  const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });

  if (error) {
    toast.error(codeErrorMessage(error));
  }

  return error === null;
};

const EmailStep = ({ onSent }: { onSent: (email: string) => void }) => {
  const [sendError, setSendError] = useState(false);
  const [shakeScope, shake] = useShake();

  const form = useForm({
    defaultValues: { email: "" },
    resolver: zodResolver(z.object({ email: z.email("Invalid email address") })),
  });

  const handleSendCode = form.handleSubmit(async ({ email }) => {
    if (await sendSignInCode(email)) {
      onSent(email);

      return;
    }

    setSendError(true);
    shake();
  });

  return (
    <HydratedForm
      ref={shakeScope}
      className="grid gap-2"
      onSubmit={(event) => {
        void handleSendCode(event);
      }}
    >
      <FieldGroup className="gap-2">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error || sendError} className="gap-1">
              <FieldLabel className="sr-only" htmlFor="email">
                Email
              </FieldLabel>
              <FieldContent>
                <Input
                  id="email"
                  data-test="email-input"
                  aria-invalid={!!fieldState.error || sendError}
                  required
                  type="email"
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  variant="frosted"
                  {...field}
                  onChange={(e) => {
                    setSendError(false);
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
        Continue with email
      </Button>
    </HydratedForm>
  );
};

const CodeStep = ({
  email,
  callbackUrl,
  onBack,
}: {
  email: string;
  callbackUrl?: string;
  onBack: () => void;
}) => {
  const router = useRouter();
  const search = useSearch({ from: "/auth" });
  const [resending, setResending] = useState(false);

  const resend = async () => {
    setResending(true);

    if (await sendSignInCode(email)) {
      toast.success(`Sent a new code to ${email}`);
    }

    setResending(false);
  };

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-center text-sm">
        We sent a {SIGN_IN_CODE_LENGTH}-digit code to{" "}
        <span className="text-foreground">{email}</span>.
      </p>
      <Field className="items-center">
        <FieldLabel className="sr-only" htmlFor="code">
          Sign-in code
        </FieldLabel>
        <OTPInput
          id="code"
          data-test="code-input"
          length={SIGN_IN_CODE_LENGTH}
          group
          autoFocus
          verify={async (otp) => {
            const [emailPrefix] = email.split("@");

            const { error } = await authClient.signIn.emailOtp({
              email,
              name: emailPrefix ?? "User",
              otp,
            });

            if (error) {
              toast.error(codeErrorMessage(error));

              return false;
            }

            return true;
          }}
          onSuccess={() => {
            if (inOAuthFlow()) {
              return;
            }

            void router.navigate({
              href: safeNextPath(callbackUrl ?? search.nextPath),
              replace: true,
            });
          }}
        />
      </Field>
      <div className="flex justify-between">
        <Button variant="link" size="sm" type="button" className="px-0" onClick={onBack}>
          Use a different email
        </Button>
        <Button
          variant="link"
          size="sm"
          type="button"
          className="px-0"
          loading={resending}
          onClick={() => {
            void resend();
          }}
        >
          Resend code
        </Button>
      </div>
    </div>
  );
};

const PROVIDER_LABELS = { github: "GitHub", google: "Google" } as const;

const authRoute = getRouteApi("/auth");

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
          onClick={() => {
            setPending(provider);
            void authClient.signIn.social({
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
export const creditCodeCallback = (code?: string) =>
  code !== undefined && code !== ""
    ? `/settings?code=${encodeURIComponent(code)}#credits`
    : undefined;

/** Signs in or up: a social provider, or an email address and the code sent to it. */
export const AuthForm = ({ className, callbackUrl, ...props }: AuthFormProps) => {
  const [email, setEmail] = useState<string>();

  return (
    <div className={cn("grid gap-6", className)} {...props}>
      {email === undefined ? (
        <>
          <SocialSignIn callbackUrl={callbackUrl} />
          <EmailStep onSent={setEmail} />
        </>
      ) : (
        <CodeStep
          email={email}
          callbackUrl={callbackUrl}
          onBack={() => {
            setEmail(undefined);
          }}
        />
      )}
    </div>
  );
};
