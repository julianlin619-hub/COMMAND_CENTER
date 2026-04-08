/**
 * Sign-In Page — renders the Clerk sign-in form centered on a dark background.
 *
 * The [[...sign-in]] catch-all route handles Clerk's multi-step auth flow
 * (email, password, MFA, SSO callback, etc.).
 */

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignIn />
    </div>
  );
}
