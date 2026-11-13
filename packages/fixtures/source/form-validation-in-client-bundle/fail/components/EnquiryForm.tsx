"use client";

import { enquirySchema } from "@/lib/enquiry-schema";
import { sendEnquiry } from "@/app/enquiry/actions";

const fields = Object.keys(enquirySchema.shape);

export function EnquiryForm() {
  return (
    <form action={sendEnquiry}>
      {fields.map((name) => (
        <input key={name} name={name} />
      ))}
      <button type="submit">Send</button>
    </form>
  );
}
