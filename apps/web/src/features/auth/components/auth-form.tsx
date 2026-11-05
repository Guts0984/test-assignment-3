"use client";

import { issuesToFieldErrors, loginBodySchema, registerBodySchema, type PublicUser } from "@app/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { callApi, fieldErrorsOf } from "@/shared/api/browser-api";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { TextField } from "@/shared/ui/text-field";
import { safeNextPath } from "../lib/redirect";

type Mode = "login" | "register";

const copy = {
  login: { title: "Log in", button: "Log in", other: "No account yet?", otherLink: "Create one", otherHref: "/register", password: "current-password" },
  register: { title: "Create an account", button: "Create account", other: "Already have an account?", otherLink: "Log in", otherHref: "/login", password: "new-password" },
} as const;

export function AuthForm({ mode, next }: { mode: Mode; next?: string | undefined }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const text = copy[mode];
  const target = safeNextPath(next);

  const submit = (form: FormData) => {
    const body = { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") };
    // Check in the browser first, with the same rules as the api, so mistakes are shown immediately.
    const checked = (mode === "register" ? registerBodySchema : loginBodySchema).safeParse(body);
    if (!checked.success) {
      setErrors(issuesToFieldErrors(checked.error.issues));
      setMessage(null);
      return;
    }
    setErrors({});
    setMessage(null);
    startTransition(async () => {
      const result = await callApi<PublicUser>(`/auth/${mode}`, { method: "POST", body: checked.data });
      if (result.ok) {
        router.push(target);
        router.refresh(); // the header must learn who is logged in
        return;
      }
      setErrors(fieldErrorsOf(result.error));
      setMessage(result.status === 400 ? "Please fix the problems below." : result.message);
    });
  };

  return (
    <form
      noValidate
      className="mx-auto w-full max-w-sm space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
      aria-labelledby="auth-title"
    >
      <h1 id="auth-title" className="text-2xl font-semibold tracking-tight">
        {text.title}
      </h1>
      {message && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <TextField id="auth-email" name="email" type="email" label="Email" autoComplete="email" errors={errors["email"]} required />
      <TextField
        id="auth-password"
        name="password"
        type="password"
        label="Password"
        autoComplete={text.password}
        errors={errors["password"]}
        hint={mode === "register" ? "At least 8 characters." : undefined}
        required
      />
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
        {pending ? "One moment…" : text.button}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {text.other}{" "}
        <Link href={`${text.otherHref}${next ? `?next=${encodeURIComponent(target)}` : ""}`} className="font-medium text-foreground underline">
          {text.otherLink}
        </Link>
      </p>
    </form>
  );
}
