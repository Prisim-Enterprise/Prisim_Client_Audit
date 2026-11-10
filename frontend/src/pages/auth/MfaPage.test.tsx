import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfaPage } from "./MfaPage";

const authMocks = vi.hoisted(() => ({
  listFactors: vi.fn(),
  enroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
  refreshContext: vi.fn(),
}));

vi.mock("../../context/AuthProvider", () => ({
  useAuth: () => ({
    context: {
      is_platform_admin: false,
      platform_admin_mfa_required: false,
      memberships: [],
    },
    contextLoading: false,
    refreshContext: authMocks.refreshContext,
    supabase: {
      auth: {
        mfa: {
          listFactors: authMocks.listFactors,
          enroll: authMocks.enroll,
          challenge: authMocks.challenge,
          verify: authMocks.verify,
          getAuthenticatorAssuranceLevel: authMocks.getAuthenticatorAssuranceLevel,
        },
      },
    },
  }),
}));

function CurrentPath() {
  const location = useLocation();
  return <output data-testid="current-path">{location.pathname}</output>;
}

describe("MfaPage bootstrap enrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    authMocks.enroll.mockResolvedValue({
      data: { id: "factor-1", totp: { uri: "otpauth://totp/PRISIM:test" } },
      error: null,
    });
    authMocks.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
    authMocks.verify.mockResolvedValue({ error: null });
    authMocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });
    authMocks.refreshContext.mockResolvedValue(undefined);
  });

  it("allows an unlisted account to enroll TOTP without granting admin access", async () => {
    render(
      <MemoryRouter initialEntries={["/mfa/setup"]}>
        <Routes>
          <Route path="/mfa/setup" element={<MfaPage bootstrapEnrollment />} />
          <Route path="/" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/does not grant staff or tenant access/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await screen.findByText(/scan this qr code/i);
    expect(authMocks.enroll).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

    await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent("/"));
    expect(authMocks.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
    expect(authMocks.getAuthenticatorAssuranceLevel).toHaveBeenCalledOnce();
    expect(authMocks.refreshContext).toHaveBeenCalledOnce();
  });
});
