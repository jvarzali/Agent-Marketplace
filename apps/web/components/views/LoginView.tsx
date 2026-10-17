"use client";

import Link from "next/link";
import { useState } from "react";

// Placeholder for Auth.js email sign-in. Submitting only shows the
// confirmation state; no email is sent from the frontend demo.
export function LoginView() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

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
            <p className="muted">
              We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 10 minutes.
            </p>
            <button className="linkbtn" onClick={() => setSent(false)}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1 className="login__title">Sign in to approve and control what your agents buy</h1>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.includes("@")) setSent(true);
              }}
            >
              <label className="field">
                <span className="field__label">Email</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button className="btn btn--primary btn--block" type="submit">
                Email me a sign-in link
              </button>
            </form>
            <p className="fine">
              New here? The same link creates your account. <Link href="/">Open the demo</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
