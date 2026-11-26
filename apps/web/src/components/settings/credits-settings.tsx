import { useEffect, useRef, useState } from "react";
import { INVITE_CODE_LENGTH } from "@repo/contract/auth/auth-limits";
import { PURCHASE_PRESETS_USD } from "@repo/contract/credits/credits-limits";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog";
import { Field, FieldLabel } from "@repo/ui/components/field";
import { OTPInput } from "@repo/ui/components/otp-input";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { formatUsd, kindLabel } from "@/lib/credits-format";
import { formatDate } from "@/lib/format";
import { authClient } from "@/auth/client";
import { codeErrorMessage, SIGN_IN_CODE_LENGTH } from "@/auth/sign-in-code";
import { useORPC } from "@/lib/orpc";

const REDEEMED_CLOSE_MS = 1200;

const PURCHASE_WATCH_MS = 60_000;
const PURCHASE_POLL_MS = 2000;

const landedSince = (entries: { kind: string; createdAt: Date }[] | undefined, since: number) =>
  entries?.some(
    (e) => e.kind === "purchase" && e.createdAt.getTime() > since - PURCHASE_WATCH_MS,
  ) ?? false;

const RedeemCode = ({
  defaultValue,
  onRedeemed,
  primary = false,
}: {
  defaultValue: string;
  onRedeemed: () => void;
  primary?: boolean;
}) => {
  const orpc = useORPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultValue !== "");

  const redeem = useMutation(
    orpc.credits.redeem.mutationOptions({
      onSuccess: async (data) => {
        toast.success(`Added ${formatUsd(data.creditedMicro)} of credit`);
        onRedeemed();
        setTimeout(() => {
          setOpen(false);
        }, REDEEMED_CLOSE_MS);

        await qc.invalidateQueries({ queryKey: orpc.credits.me.queryKey() });
      },
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          primary ? (
            <Button type="button" variant="outline" size="sm" />
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-auto px-0 text-xs"
            />
          )
        }
      >
        {primary ? "Redeem a code" : "Have a code? Redeem it"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Redeem a code</DialogTitle>
          <DialogDescription>Each code adds credit once per account.</DialogDescription>
        </DialogHeader>
        <Field className="items-center">
          <FieldLabel className="sr-only" htmlFor="credit-code">
            Code
          </FieldLabel>
          <OTPInput
            id="credit-code"
            data-test="credit-code-input"
            length={INVITE_CODE_LENGTH}
            validationType="alphanumeric"
            normalizeValue={(value) => value.toUpperCase()}
            defaultValue={defaultValue}
            group
            verify={async (code) => {
              try {
                await redeem.mutateAsync({ code });

                return true;
              } catch {
                return false;
              }
            }}
          />
        </Field>
      </DialogContent>
    </Dialog>
  );
};

const VerifyEmailToRedeem = ({ email }: { email: string }) => {
  const orpc = useORPC();
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  const send = async () => {
    setState("sending");

    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    });

    if (error) {
      toast.error(codeErrorMessage(error));
      setState("idle");

      return;
    }

    setState("sent");
  };

  if (state === "sent") {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          Enter the code we sent to {email}, then redeem your code here.
        </p>
        <Field>
          <FieldLabel className="sr-only" htmlFor="confirm-email-code">
            Confirmation code
          </FieldLabel>
          <OTPInput
            id="confirm-email-code"
            data-test="confirm-email-code-input"
            length={SIGN_IN_CODE_LENGTH}
            group
            verify={async (otp) => {
              const { error } = await authClient.emailOtp.verifyEmail({ email, otp });

              if (error) {
                toast.error(codeErrorMessage(error));

                return false;
              }

              return true;
            }}
            onSuccess={() => {
              void qc.invalidateQueries({ queryKey: orpc.credits.me.queryKey() });
            }}
          />
        </Field>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">Confirm {email} to redeem a code.</p>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-xs"
        loading={state === "sending"}
        onClick={() => {
          void send();
        }}
      >
        Send a confirmation code
      </Button>
    </div>
  );
};

const BuyCredits = ({ children }: { children: React.ReactNode }) => {
  const orpc = useORPC();

  const checkout = useMutation(
    orpc.credits.checkout.mutationOptions({
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
    }),
  );

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Buy credits</div>
      <div className="flex flex-wrap gap-2">
        {PURCHASE_PRESETS_USD.map((amountUsd) => (
          <Button
            key={amountUsd}
            type="button"
            variant="outline"
            size="sm"
            disabled={checkout.isPending && checkout.variables?.amountUsd !== amountUsd}
            loading={checkout.isPending && checkout.variables?.amountUsd === amountUsd}
            onClick={() => {
              checkout.mutate({ amountUsd });
            }}
          >
            ${amountUsd}
          </Button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Paid by card through Stripe. One dollar buys one dollar of generation.
      </p>
      {children}
    </div>
  );
};

const AddCredit = ({ children }: { children: React.ReactNode }) => (
  <div className="space-y-2">
    <div className="text-sm font-medium">Add credit</div>
    {children}
    <p className="text-muted-foreground text-xs">Card payments aren&apos;t open yet.</p>
  </div>
);

const CreditsSkeleton = () => (
  <div className="space-y-8">
    <div>
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Balance
      </div>
      <Skeleton className="mt-2 h-8 w-28" />
    </div>
    <div>
      <ul className="divide-y divide-white/10 border-t border-white/10">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 py-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="ml-auto h-3 w-12" />
          </li>
        ))}
      </ul>
    </div>
  </div>
);

export const CreditsSettings = ({
  code,
  email,
  purchase,
  onCodeRedeemed,
}: {
  /** A credit code from the link (`?code=`), prefilled into the redeem field. */
  code?: string;
  email: string;
  /** True when Stripe has just sent the person back from a paid checkout. */
  purchase: boolean;
  /** Drops `?code=` once used, so a reload doesn't redeem it again. */
  onCodeRedeemed: () => void;
}) => {
  const orpc = useORPC();
  const sectionRef = useRef<HTMLElement>(null);
  const [watchingSince, setWatchingSince] = useState(() => (purchase ? Date.now() : null));

  const credits = useQuery({
    ...orpc.credits.me.queryOptions(),
    refetchInterval: (query) =>
      watchingSince !== null && !landedSince(query.state.data?.entries, watchingSince)
        ? PURCHASE_POLL_MS
        : false,
  });

  const purchaseLanded =
    watchingSince !== null && landedSince(credits.data?.entries, watchingSince);

  const watching = watchingSince !== null && !purchaseLanded;

  useEffect(() => {
    if (purchaseLanded) {
      toast.success("Payment received — credits added");
    }
  }, [purchaseLanded]);

  useEffect(() => {
    const timer =
      watchingSince === null
        ? undefined
        : setTimeout(() => {
            setWatchingSince(null);
          }, PURCHASE_WATCH_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [watchingSince]);

  useEffect(() => {
    if ((code !== undefined && code !== "") || purchase) {
      sectionRef.current?.scrollIntoView({ block: "start" });
    }
  }, [code, purchase]);

  return (
    <section
      ref={sectionRef}
      id="credits"
      className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-6 py-12 first:pt-0 last:pb-0 md:grid-cols-3"
    >
      <header>
        <h2 className="text-base font-semibold">Credits</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Credits cover asset generation; deploys, hosting and multiplayer are free.
          {credits.data?.purchasesEnabled === true &&
            " Buy credits, or redeem a code if you have one."}
          {credits.data?.purchasesEnabled === false && " Redeem a code to add credit."}
        </p>
      </header>

      <div className="md:col-span-2">
        {credits.isError && (
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t load credits. Try reloading.
          </p>
        )}

        {!credits.isError && (
          <SkeletonReveal ready={credits.data !== undefined} skeleton={<CreditsSkeleton />}>
            {credits.data && (
              <div className="space-y-8">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Balance
                  </div>
                  <div className="mt-1 text-3xl font-light tabular-nums">
                    {formatUsd(credits.data.balanceMicro)}
                  </div>
                  {watching && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Waiting for your payment to clear…
                    </p>
                  )}
                </div>

                {credits.data.purchasesEnabled ? (
                  <BuyCredits>
                    {credits.data.mustVerifyEmail ? (
                      <VerifyEmailToRedeem email={email} />
                    ) : (
                      <RedeemCode defaultValue={code ?? ""} onRedeemed={onCodeRedeemed} />
                    )}
                  </BuyCredits>
                ) : (
                  <AddCredit>
                    {credits.data.mustVerifyEmail ? (
                      <VerifyEmailToRedeem email={email} />
                    ) : (
                      <RedeemCode defaultValue={code ?? ""} onRedeemed={onCodeRedeemed} primary />
                    )}
                  </AddCredit>
                )}

                <div>
                  {credits.data.entries.length === 0 && (
                    <p className="text-muted-foreground text-sm">No activity yet.</p>
                  )}
                  {credits.data.entries.length > 0 && (
                    <ul className="divide-y divide-white/10 border-t border-white/10">
                      {credits.data.entries.map((e) => (
                        <li key={e.id} className="flex items-center gap-3 py-4 text-sm">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {kindLabel(e.kind, e.deltaMicro)}
                            </div>
                            <div className="text-muted-foreground text-xs">
                              {e.endpointId !== null && (
                                <>
                                  <code className="font-mono">{e.endpointId}</code> ·{" "}
                                </>
                              )}
                              {formatDate(e.createdAt)}
                            </div>
                          </div>
                          <span
                            className={`ml-auto font-mono text-xs tabular-nums ${
                              e.deltaMicro < 0 ? "text-red-300/90" : "text-green-300/90"
                            }`}
                          >
                            {e.deltaMicro > 0 ? "+" : ""}
                            {formatUsd(e.deltaMicro)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </SkeletonReveal>
        )}
      </div>
    </section>
  );
};
