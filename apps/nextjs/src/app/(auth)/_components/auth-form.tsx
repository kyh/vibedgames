"use client";

import { useParams, useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { toast } from "@repo/ui/toast";
import { cn } from "@repo/ui/utils";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/lib/auth-client";

type AuthFormProps = {
  type: "login" | "register";
} & React.HTMLAttributes<HTMLDivElement>;

export const AuthForm = ({ className, type, ...props }: AuthFormProps) => {
  const router = useRouter();
  const params = useParams<{ nextPath?: string }>();

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
            router.replace(params.nextPath ?? "/");
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
            router.replace(params.nextPath ?? "/");
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
      <Form {...form}>
        <form className="grid gap-2" onSubmit={handleAuthWithPassword}>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem className="grid gap-1 space-y-0">
                <FormLabel className="sr-only">Email</FormLabel>
                <FormControl>
                  <Input
                    data-test="email-input"
                    required
                    type="email"
                    placeholder="name@example.com"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect="off"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem className="grid gap-1 space-y-0">
                <FormLabel className="sr-only">Password</FormLabel>
                <FormControl>
                  <Input
                    data-test="password-input"
                    required
                    type="password"
                    placeholder="******"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    autoCorrect="off"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button loading={form.formState.isSubmitting}>
            {type === "login" ? "Login" : "Register"}
          </Button>
        </form>
      </Form>
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
        <div className="rounded-md bg-green-50 p-4 dark:bg-green-900/20">
          <p className="text-sm text-green-800 dark:text-green-200">
            Password reset email sent! Check your inbox and follow the
            instructions to reset your password.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form className="grid gap-4" onSubmit={handlePasswordReset}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="grid gap-1 space-y-0">
              <FormLabel className="sr-only">Email</FormLabel>
              <FormControl>
                <Input
                  required
                  type="email"
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button loading={form.formState.isSubmitting}>
          Request Password Reset
        </Button>
      </form>
    </Form>
  );
};

export const UpdatePasswordForm = () => {
  const router = useRouter();

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
          router.push("/");
        },
        onError: (ctx) => {
          toast.error(ctx.error.message);
        },
      },
    });
  });

  return (
    <Form {...form}>
      <form className="grid gap-4" onSubmit={handleUpdatePassword}>
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem className="grid gap-1 space-y-0">
              <FormLabel className="sr-only">New Password</FormLabel>
              <FormControl>
                <Input
                  required
                  type="password"
                  placeholder="Enter new password"
                  autoCapitalize="none"
                  autoComplete="new-password"
                  autoCorrect="off"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem className="grid gap-1 space-y-0">
              <FormLabel className="sr-only">Confirm New Password</FormLabel>
              <FormControl>
                <Input
                  required
                  type="password"
                  placeholder="Confirm new password"
                  autoCapitalize="none"
                  autoComplete="new-password"
                  autoCorrect="off"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button loading={form.formState.isSubmitting}>Update Password</Button>
      </form>
    </Form>
  );
};
