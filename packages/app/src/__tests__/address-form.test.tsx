// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressForm } from "../AddressForm";
import { ApiError } from "../api";

afterEach(cleanup);

describe("the address form", () => {
  it("has a labelled field and a Check button", () => {
    render(<AddressForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Address to check")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
  });

  it("empty: says what to enter and sends nothing", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<AddressForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(onSubmit).not.toHaveBeenCalled();
    const field = screen.getByLabelText("Address to check");
    expect(screen.getByRole("alert").textContent).toBe("Enter an address, such as yoursite.com.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });

  it("whitespace only counts as empty", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<AddressForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("Address to check"), "   {enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("a server 400 shows the server's sentence next to the field and keeps what was typed", async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiError(400, "That doesn't look like an address.");
    });
    render(<AddressForm onSubmit={onSubmit} />);
    const field = screen.getByLabelText<HTMLInputElement>("Address to check");
    await userEvent.type(field, "not an address{enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That doesn't look like an address.",
    );
    expect(field.value).toBe("not an address");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("the sentence goes away when the person types again", async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiError(400, "Nope.");
    });
    render(<AddressForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("Address to check"), "x{enter}");
    await screen.findByRole("alert");
    await userEvent.type(screen.getByLabelText("Address to check"), "y");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables the button while posting, then clears the field on success", async () => {
    let finish: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<AddressForm onSubmit={onSubmit} />);
    const field = screen.getByLabelText<HTMLInputElement>("Address to check");
    await userEvent.type(field, "shop.example{enter}");
    const button = screen.getByRole("button", { name: /Check/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(onSubmit).toHaveBeenCalledWith("shop.example");
    // A second Enter while posting sends nothing more.
    await userEvent.type(field, "{enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(field.value).toBe(""));
    expect(button.disabled).toBe(false);
  });

  it("trims the address it sends", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<AddressForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("Address to check"), "  shop.example  {enter}");
    expect(onSubmit).toHaveBeenCalledWith("shop.example");
  });

  it("any other failure shows its message too", async () => {
    render(
      <AddressForm
        onSubmit={async () => {
          throw new Error("The app couldn't reach the server.");
        }}
      />,
    );
    await userEvent.type(screen.getByLabelText("Address to check"), "x{enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The app couldn't reach the server.",
    );
  });
});
