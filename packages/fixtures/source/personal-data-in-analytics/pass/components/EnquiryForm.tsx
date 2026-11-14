"use client";

interface Values {
  email: string;
  phone: string;
  message: string;
}

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

export function EnquiryForm({ send }: { send: (values: Values) => Promise<void> }) {
  async function onSubmit(values: Values) {
    await send(values);
    window.dataLayer?.push({ event: "enquiry_sent", form: "private-dining" });
  }
  return <button onClick={() => onSubmit({ email: "", phone: "", message: "" })}>Send</button>;
}
