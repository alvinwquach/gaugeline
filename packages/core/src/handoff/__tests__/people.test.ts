// check-community: allow-email (invented addresses at reserved example domains, only ever compared and masked)
import { describe, expect, it } from "vitest";
import { createPeople, maskEmail, normalizeEmail } from "../people.js";

describe("normalizeEmail", () => {
  it("trims and lower-cases, and leaves the rest alone", () => {
    expect(normalizeEmail("  Rosa@Marlowe-Bar.EXAMPLE ")).toBe("rosa@marlowe-bar.example");
    expect(normalizeEmail("rosa+bar@marlowe-bar.example")).toBe("rosa+bar@marlowe-bar.example");
  });
});

describe("maskEmail: the domain and the first letter, never the whole address", () => {
  it("shows the first letter and the domain", () => {
    expect(maskEmail("owner@client.example")).toBe("o***@client.example");
    expect(maskEmail("Rosa@Marlowe-Bar.example")).toBe("r***@marlowe-bar.example");
  });
  it("masks a plus address and a one-letter name the same way", () => {
    expect(maskEmail("a+news@client.example")).toBe("a***@client.example");
  });
  it("keeps a first letter that is outside ASCII whole", () => {
    expect(maskEmail("\u00E9lodie@clinique.example")).toBe("\u00E9***@clinique.example");
  });
  it("never echoes something that is not an address", () => {
    expect(maskEmail("not an address")).toBe("***");
    expect(maskEmail("")).toBe("***");
    expect(maskEmail("@client.example")).toBe("***");
    expect(maskEmail("a@b@c.example")).toBe("***");
  });
  it("never contains the part before the first letter", () => {
    const masked = maskEmail("rosalind.marlowe@marlowe-bar.example");
    expect(masked).not.toContain("osalind");
    expect(masked).not.toContain("marlowe.");
  });
});

describe("createPeople: whose address is it", () => {
  const people = createPeople({
    clientEmails: ["Rosa@marlowe-bar.example"],
    freelancerEmails: ["dev@harbour-studio.example", "dev.harbour@mail.example"],
    sameAs: [["dev@harbour-studio.example", "dev.harbour@mail.example"]],
  });

  it("compares addresses without regard to case or spaces", () => {
    expect(people.partyOf("ROSA@marlowe-bar.example ")).toBe("client");
    expect(people.partyOf("dev@harbour-studio.example")).toBe("freelancer");
    expect(people.partyOf("someone@else.example")).toBe("other");
  });

  it("is client only when a client address was given", () => {
    expect(people.hasClient).toBe(true);
    expect(createPeople({}).hasClient).toBe(false);
    expect(createPeople({}).partyOf("rosa@marlowe-bar.example")).toBe("other");
  });

  it("gives one key to the same person under two addresses", () => {
    expect(people.personOf("dev@harbour-studio.example")).toBe(
      people.personOf("DEV.HARBOUR@mail.example"),
    );
    expect(people.personOf("rosa@marlowe-bar.example")).not.toBe(
      people.personOf("dev@harbour-studio.example"),
    );
  });

  it("gives two different people two different keys, listed or not", () => {
    expect(people.personOf("x@else.example")).not.toBe(people.personOf("y@else.example"));
    expect(people.personOf("x@else.example")).toBe(people.personOf("X@else.example"));
  });

  it("does not put an address in a key", () => {
    expect(people.personOf("rosa@marlowe-bar.example")).not.toMatch(/rosa|marlowe|@/);
  });

  it("chains groups that share an address into one person", () => {
    const chained = createPeople({
      freelancerEmails: ["a@x.example", "b@x.example", "c@x.example"],
      sameAs: [
        ["a@x.example", "b@x.example"],
        ["b@x.example", "c@x.example"],
      ],
    });
    expect(chained.personOf("a@x.example")).toBe(chained.personOf("c@x.example"));
  });
});
