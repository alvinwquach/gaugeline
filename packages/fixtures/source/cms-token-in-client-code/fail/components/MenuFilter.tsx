"use client";

import { useState } from "react";
import { client } from "../lib/sanity";

export function MenuFilter() {
  const [section, setSection] = useState("draught");
  void client;
  return <button onClick={() => setSection("cans")}>{section}</button>;
}
