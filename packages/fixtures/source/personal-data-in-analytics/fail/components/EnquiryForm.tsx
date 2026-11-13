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
    window.dataLayer?.push({ event: "enquiry_sent", email: values.email, phone: values.phone });
  }
  return <button onClick={() => onSubmit({ email: "", phone: "", message: "" })}>Send</button>;
}
