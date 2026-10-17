import type { MemoriesClient } from "@memories/client";
import type { CloudAdminUser, CloudStatus, CloudUser } from "@memories/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CloudSettings } from "./Cloud.js";

afterEach(cleanup);

const me: CloudUser = { id: "me", email: "firdaus@example.com", name: "Firdaus", role: "admin", emailVerified: true, image: null };

function fakeCloud(initial: Partial<CloudStatus> = {}) {
  const calls: string[] = [];
  let status: CloudStatus = {
    available: true,
    serverUrl: "https://cloud.test",
    providers: ["google", "apple"],
    user: null,
    sync: { enabled: false, pending: 0, lastSyncedAt: null, error: null, running: false },
    storageDriveId: null,
    ...initial,
  };
  let people: CloudAdminUser[] = [
    { ...me, banned: false, banReason: null, createdAt: "2026-01-01T00:00:00Z" },
    { id: "p1", email: "aisha@example.com", name: "Aisha", role: "user", emailVerified: true, image: null, banned: false, banReason: null, createdAt: "2026-01-02T00:00:00Z" },
  ];
  const client = {
    cloudStatus: async () => status,
    cloudSignIn: async (input: { email: string; password: string }) => {
      calls.push(`signIn:${input.email}:${input.password}`);
      status = { ...status, user: { ...me, email: input.email, role: "user" } };
      return status.user;
    },
    cloudSignUp: async (input: { name: string; email: string }) => {
      calls.push(`signUp:${input.name}:${input.email}`);
      status = { ...status, user: { ...me, name: input.name, email: input.email, role: "user", emailVerified: false } };
      return status.user;
    },
    cloudSignInWith: async (provider: string) => {
      calls.push(`provider:${provider}`);
      return { url: "" };
    },
    cloudSignOut: async () => {
      calls.push("signOut");
      status = { ...status, user: null };
      return { ok: true };
    },
    cloudForgotPassword: async (email: string) => (calls.push(`forgot:${email}`), { ok: true }),
    cloudSetSync: async (enabled: boolean) => {
      calls.push(`sync:${enabled}`);
      status = { ...status, sync: { ...status.sync, enabled, lastSyncedAt: enabled ? new Date().toISOString() : null } };
      return status;
    },
    cloudAddStorage: async () => {
      calls.push("addStorage");
      status = { ...status, storageDriveId: "drv_cloud" };
      return { id: "drv_cloud" };
    },
    cloudUsers: async () => ({ users: people, total: people.length }),
    cloudSetRole: async (id: string, role: string) => {
      calls.push(`role:${id}:${role}`);
      people = people.map((p) => (p.id === id ? { ...p, role: role as CloudUser["role"] } : p));
      return { ok: true };
    },
    cloudBan: async (id: string) => {
      calls.push(`ban:${id}`);
      people = people.map((p) => (p.id === id ? { ...p, banned: true } : p));
      return { ok: true };
    },
    cloudRemoveUser: async (id: string) => {
      calls.push(`remove:${id}`);
      people = people.filter((p) => p.id !== id);
      return { ok: true };
    },
  } as unknown as MemoriesClient;
  return { client, calls };
}

describe("CloudSettings", () => {
  it("keeps the local-only promise when the app has no cloud", async () => {
    const { client } = fakeCloud({ available: false });
    render(<CloudSettings client={client} onPlacesChanged={() => undefined} />);
    expect(await screen.findByText("Everything stays on this computer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("signs in with email and password, then turns on sync and cloud storage", async () => {
    const { client, calls } = fakeCloud();
    let placesChanged = 0;
    render(<CloudSettings client={client} onPlacesChanged={() => placesChanged++} />);
    expect(await screen.findByText("Memories works without an account")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const form = screen.getByRole("form", { name: "Sign in" });
    expect(within(form).getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "firdaus@example.com" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("firdaus@example.com")).toBeTruthy();
    expect(calls).toContain("signIn:firdaus@example.com:correct horse battery");

    fireEvent.click(screen.getByRole("switch", { name: "Keep my library list in the cloud" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Keep my library list in the cloud" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Add to places" }));
    expect(await screen.findByText("In your places")).toBeTruthy();
    expect(placesChanged).toBe(1);
    expect(calls).toEqual(expect.arrayContaining(["sync:true", "addStorage"]));

    // Normal users don't see people management.
    expect(screen.queryByRole("heading", { name: "People" })).toBeNull();
  });

  it("creates an account and offers provider sign-in in the browser", async () => {
    const { client, calls } = fakeCloud();
    render(<CloudSettings client={client} onPlacesChanged={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    const form = screen.getByRole("form", { name: "Create account" });
    fireEvent.click(within(form).getByRole("button", { name: "Continue with Apple" }));
    expect(await screen.findByText("Finish signing in in your browser")).toBeTruthy();
    expect(calls).toContain("provider:apple");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const again = screen.getByRole("form", { name: "Sign in" });
    fireEvent.click(within(again).getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const signUp = screen.getByRole("form", { name: "Create account" });
    fireEvent.change(within(signUp).getByLabelText("Your name"), { target: { value: "Aisha" } });
    fireEvent.change(within(signUp).getByLabelText("Email"), { target: { value: "aisha@example.com" } });
    fireEvent.change(within(signUp).getByLabelText("Password"), { target: { value: "a long password" } });
    fireEvent.click(within(signUp).getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/We sent you an email/)).toBeTruthy();
    expect(screen.getByText("Please confirm your email.", { exact: false })).toBeTruthy();
  });

  it("lets an admin manage people, but not remove themselves", async () => {
    const { client, calls } = fakeCloud({ user: me });
    render(<CloudSettings client={client} onPlacesChanged={() => undefined} />);
    const list = await screen.findByRole("list", { name: "People" });
    await within(list).findByText("aisha@example.com");
    const aisha = within(list).getByText("aisha@example.com").closest("li")!;
    const mine = within(list).getByText("firdaus@example.com").closest("li")!;
    expect(within(mine).queryByRole("button", { name: "Remove" })).toBeNull();

    fireEvent.click(within(aisha).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(calls).toContain("role:p1:admin"));
    fireEvent.click(await within(aisha).findByRole("button", { name: "Block" }));
    await waitFor(() => expect(calls).toContain("ban:p1"));
    fireEvent.click(within(aisha).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(aisha).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(list).queryByText("aisha@example.com")).toBeNull());
    expect(calls).toContain("remove:p1");
  });
});
