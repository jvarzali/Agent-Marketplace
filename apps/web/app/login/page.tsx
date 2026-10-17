import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginView } from "@/components/views/LoginView";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  Verification: "That sign-in link has expired or was already used. Ask for a new one.",
};

type Params = { callbackUrl?: string; type?: string; error?: string };

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const { callbackUrl, type, error } = await searchParams;
  const back = callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/";
  if ((await auth())?.user) redirect(back);
  return (
    <LoginView
      callbackUrl={back}
      sent={type === "email"}
      error={error ? (ERRORS[error] ?? "Sign-in didn't work. Try again.") : null}
    />
  );
}
