"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInWithEmail } from "@/lib/actions";

// Email magic-link sign-in (Auth.js). The same link creates the account on first use.
export function LoginView({ callbackUrl, sent, error }: { callbackUrl: string; sent: boolean; error: string | null }) {
  const [state, action, pending] = useActionState(signInWithEmail, { error: null });
  const shownError = state.error ?? error;

  return (
    <div className="login">
      <div className="login__card">
        <p className="brand">
          <span className="brand__mark" aria-hidden="true" />
          AgentMart
        </p>
        {sent ? (
          <>
            <h1 className="login__title">Check your email</h1>
            <p className="muted">We sent you a sign-in link. It works once and expires in 10 minutes.</p>
            <Link className="linkbtn" href="/login">
              Use a different email
            </Link>
          </>
        ) : (
          <>
            <h1 className="login__title">Sign in to approve and control what your agents buy</h1>
            <form className="stack" action={action}>
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <label className="field">
                <span className="field__label">Email</span>
                <input className="input" type="email" name="email" autoComplete="email" required />
              </label>
              {shownError && (
                <p className="banner banner--stop" role="alert">
                  {shownError}
                </p>
              )}
              <button className="btn btn--primary btn--block" type="submit" disabled={pending}>
                {pending ? "Sending…" : "Email me a sign-in link"}
              </button>
            </form>
            <p className="fine">New here? The same link creates your account.</p>
          </>
        )}
      </div>
    </div>
  );
}
