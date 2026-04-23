import { zodResolver } from "@hookform/resolvers/zod";
import { joinWaitlistInput } from "@repo/api/waitlist/waitlist-schema";
import { Button } from "@repo/ui/components/button";
import { Field, FieldContent, FieldError, FieldLabel } from "@repo/ui/components/field";
import { toast } from "@repo/ui/components/sonner";
import { cn } from "@repo/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";

import { useTRPC } from "@/lib/trpc";

export const WaitlistForm = () => {
  const trpc = useTRPC();
  const joinWaitlist = useMutation(trpc.waitlist.join.mutationOptions());

  const form = useForm({
    resolver: zodResolver(joinWaitlistInput),
    defaultValues: {
      email: "",
    },
  });

  const handleJoinWaitlist = form.handleSubmit((values) => {
    toast.promise(
      joinWaitlist.mutateAsync({ email: values.email }).then(() => {
        form.reset({ email: "" });
      }),
      {
        loading: "Submitting...",
        success: "Waitlist joined!",
        error: "Failed to join waitlist",
      },
    );
  });

  return (
    <form
      onSubmit={handleJoinWaitlist}
      className="bg-input flex max-w-sm items-center gap-2 rounded-xl border border-white/10 shadow-lg"
    >
      <Controller
        control={form.control}
        name="email"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error} className="min-w-0 flex-1">
            <FieldLabel className="sr-only" htmlFor="waitlist-email">
              Email
            </FieldLabel>
            <FieldContent>
              <input
                id="waitlist-email"
                className="w-full border-none bg-transparent py-3 pl-4 text-sm placeholder-white/50 focus:placeholder-white/75 focus:ring-0 focus:outline-hidden"
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
            <FieldError className="absolute pt-1">{fieldState.error?.message}</FieldError>
          </Field>
        )}
      />
      <Button
        className={cn(
          "text-xs text-black hover:text-black",
          joinWaitlist.isPending && "[&>:first-child]:bg-input",
        )}
        variant="ghost"
        loading={joinWaitlist.isPending}
      >
        Join Waitlist
      </Button>
    </form>
  );
};
