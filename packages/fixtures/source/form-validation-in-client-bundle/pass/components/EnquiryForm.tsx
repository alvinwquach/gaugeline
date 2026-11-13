"use client";

import { ENQUIRY_FIELDS } from "@/lib/enquiry-fields";
import { sendEnquiry } from "@/app/enquiry/actions";

export function EnquiryForm() {
  return (
    <form action={sendEnquiry}>
      {ENQUIRY_FIELDS.map((name) => (
        <input key={name} name={name} />
      ))}
      <button type="submit">Send</button>
    </form>
  );
}
