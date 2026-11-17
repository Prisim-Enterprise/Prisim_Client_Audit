import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetPasswordPage } from "./ResetPasswordPage";

const auth = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  verifyPasswordLink: vi.fn(),
  updatePassword: vi.fn(),
}));

vi.mock("../../context/AuthProvider", () => ({
  useAuth: () => ({
    user: auth.user,
    authLoading: false,
    verifyPasswordLink: auth.verifyPasswordLink,
    updatePassword: auth.updatePassword,
  }),
}));

function CurrentUrl() {
  const location = useLocation();
  return <output data-testid="url">{location.pathname + location.search}</output>;
}

function renderAt(url: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/reset-password" element={<><ResetPasswordPage /><CurrentUrl /></>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  auth.user = null;
});

describe("ResetPasswordPage password links", () => {
  it("verifies a staff-issued link exactly once, removes the token from the URL and lets the user set a password", async () => {
    auth.verifyPasswordLink.mockImplementation(async () => {
      auth.user = { id: "u1", email: "owner@client.example" };
    });
    auth.updatePassword.mockResolvedValue(undefined);
    renderAt("/reset-password?token_hash=abc123&type=recovery");

    expect(await screen.findByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
    expect(auth.verifyPasswordLink).toHaveBeenCalledTimes(1);
    expect(auth.verifyPasswordLink).toHaveBeenCalledWith("abc123");
    expect(screen.getByTestId("url")).toHaveTextContent(/^\/reset-password$/);
    expect(screen.getByText("owner@client.example")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("New password"), "Stronger-Pass1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "Stronger-Pass1");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("heading", { name: "Password saved" })).toBeInTheDocument();
    expect(auth.updatePassword).toHaveBeenCalledWith("Stronger-Pass1");
  });

  it("shows a clear message for an expired or used link and never shows the password form", async () => {
    auth.verifyPasswordLink.mockRejectedValue(new Error("This password link has expired or was already used."));
    renderAt("/reset-password?token_hash=used&type=recovery");
    expect(await screen.findByRole("heading", { name: "Password link unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent(/^\/reset-password$/);
  });

  it("ignores tokens of other link types", async () => {
    renderAt("/reset-password?token_hash=abc&type=magiclink");
    expect(await screen.findByRole("heading", { name: "Password link unavailable" })).toBeInTheDocument();
    expect(auth.verifyPasswordLink).not.toHaveBeenCalled();
  });

  it("rejects a weak password before calling Supabase", async () => {
    auth.user = { id: "u1", email: "owner@client.example" };
    renderAt("/reset-password");
    await userEvent.type(screen.getByLabelText("New password"), "short");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true"));
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });
});
