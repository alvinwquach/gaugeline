"use client";

import { useState } from "react";

export function MenuFilter({ sections }: { sections: string[] }) {
  const [section, setSection] = useState(sections[0]);
  return <button onClick={() => setSection(sections[1])}>{section}</button>;
}
