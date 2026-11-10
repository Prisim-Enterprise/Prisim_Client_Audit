export function friendlyAuthError(error: unknown, action: "sign-in" | "recovery" | "password" = "sign-in") {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (action === "sign-in") {
    if (message.includes("invalid login credentials")) {
      return "The email or password is incorrect. Check your details and try again.";
    }
    if (message.includes("email not confirmed")) {
      return "Confirm your email address before signing in. Contact your PRISIM administrator if you need help.";
    }
    if (message.includes("too many requests") || message.includes("rate limit")) {
      return "There have been too many attempts. Wait a few minutes and try again.";
    }
    return "We couldn't sign you in. Check your connection and try again.";
  }

  if (action === "recovery") {
    return "We couldn't send a recovery email right now. Check your connection and try again.";
  }

  return "We couldn't update your password. The reset link may have expired; request a new one and try again.";
}
