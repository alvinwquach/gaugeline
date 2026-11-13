"use client";
import { useDraftModePerspective } from "next-sanity/hooks";

export function DebugStatus() {
  const perspective = useDraftModePerspective();
  return <p>Perspective: {JSON.stringify(perspective)}</p>;
}
