import { describe, expect, it } from "vitest";
import { googleRole, isAdminRole, sanityRole, vercelRole } from "../roles.js";

describe("role mapping per provider: owner, admin, member, viewer", () => {
  it("Vercel: OWNER owns, the working roles are members, the viewing roles view", () => {
    expect(vercelRole("OWNER")).toBe("owner");
    for (const r of ["MEMBER", "DEVELOPER", "SECURITY", "BILLING", "CONTRIBUTOR"])
      expect(vercelRole(r), r).toBe("member");
    for (const r of ["VIEWER", "VIEWER_FOR_PLUS"]) expect(vercelRole(r), r).toBe("viewer");
  });

  it("Vercel: case does not matter, and a role it does not know is unknown", () => {
    expect(vercelRole("owner")).toBe("owner");
    expect(vercelRole("TEAPOT")).toBe("unknown");
    expect(vercelRole("")).toBe("unknown");
  });

  it("Sanity: administrator is admin, editors and developers are members, viewers view", () => {
    expect(sanityRole("administrator")).toBe("admin");
    expect(sanityRole("owner")).toBe("owner");
    for (const r of ["editor", "developer", "contributor", "deploy-studio"])
      expect(sanityRole(r), r).toBe("member");
    expect(sanityRole("viewer")).toBe("viewer");
  });

  it("Sanity: several roles give the highest, and a custom role is unknown", () => {
    expect(sanityRole(["viewer", "administrator"])).toBe("admin");
    expect(sanityRole(["editor", "viewer"])).toBe("member");
    expect(sanityRole("night-shift-editors")).toBe("unknown");
    expect(sanityRole([])).toBe("unknown");
  });

  it("Google Business Profile: both kinds of owner own, a manager and a site manager are members", () => {
    expect(googleRole("PRIMARY_OWNER")).toBe("owner");
    expect(googleRole("OWNER")).toBe("owner");
    expect(googleRole("MANAGER")).toBe("member");
    expect(googleRole("SITE_MANAGER")).toBe("member");
    expect(googleRole("ROLE_UNSPECIFIED")).toBe("unknown");
  });

  it("only an owner or an admin can let someone in", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    for (const r of ["member", "viewer", "unknown"] as const) expect(isAdminRole(r), r).toBe(false);
  });
});
