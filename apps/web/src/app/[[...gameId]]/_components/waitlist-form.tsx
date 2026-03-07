"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { joinWaitlistInput } from "@repo/api/waitlist/waitlist-schema";
import { Button } from "@repo/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/ui/form";
import { toast } from "@repo/ui/toast";
import { cn } from "@repo/ui/utils";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { useTRPC } from "@/trpc/react";

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
    <Form {...form}>
      <form
        onSubmit={handleJoinWaitlist}
        className="bg-input flex max-w-sm items-center gap-2 rounded-xl border border-white/10 shadow-lg"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1 space-y-0">
              <FormLabel className="sr-only">Email</FormLabel>
              <FormControl>
                <input
                  className="w-full border-none bg-transparent py-3 pl-4 text-sm placeholder-white/50 focus:placeholder-white/75 focus:ring-0 focus:outline-hidden"
                  required
                    type="email"
                    placeholder="name@example.com"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect="off"
                    {...field}
                    value={field.value}
                  />
              </FormControl>
              <FormMessage className="absolute pt-1" />
            </FormItem>
          )}
        />
        <Button
          className={cn(
            "text-xs",
            joinWaitlist.isPending && "[&>:first-child]:bg-input",
          )}
          variant="ghost"
          loading={joinWaitlist.isPending}
        >
          Join Waitlist
        </Button>
      </form>
    </Form>
  );
};

type WaitlistDialogProps = {
  waitlistOpen: boolean;
  setWaitlistOpen: (open: boolean) => void;
};

export const WaitlistDailog = ({
  waitlistOpen,
  setWaitlistOpen,
}: WaitlistDialogProps) => {
  return (
    <Dialog open={waitlistOpen} onOpenChange={setWaitlistOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-foreground mx-auto text-center text-xl font-semibold tracking-tight sm:text-2xl">
            Join the waitlist
          </DialogTitle>
          <DialogDescription className="text-center text-balance">
            Vibedgames is currently in private beta. Join the waitlist to get
            early access.
          </DialogDescription>
        </DialogHeader>
        <div className="mx-auto mt-3 mb-5">
          <WaitlistForm />
        </div>
        <svg
          viewBox="0 0 1024 1024"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-256 -translate-x-1/2"
        >
          <circle
            r={512}
            cx={512}
            cy={512}
            fill="url(#759c1415-0410-454c-8f7c-9a820de03641)"
            fillOpacity="0.7"
          />
          <defs>
            <radialGradient
              r={1}
              cx={0}
              cy={0}
              id="759c1415-0410-454c-8f7c-9a820de03641"
              gradientUnits="userSpaceOnUse"
              gradientTransform="translate(512 512) rotate(90) scale(512)"
            >
              <stop stopColor="#7775D6" />
              <stop offset={1} stopColor="#E935C1" stopOpacity={0} />
            </radialGradient>
          </defs>
        </svg>
      </DialogContent>
    </Dialog>
  );
};
