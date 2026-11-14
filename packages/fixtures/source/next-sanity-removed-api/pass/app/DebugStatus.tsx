"use client";
import { useVisualEditingEnvironment } from "next-sanity/hooks";

export function DebugStatus() {
  const environment = useVisualEditingEnvironment();
  return <p>Environment: {JSON.stringify(environment)}</p>;
}
