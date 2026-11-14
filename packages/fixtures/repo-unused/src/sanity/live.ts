import { defineLive } from "next-sanity";
import { client } from "@/lib/client";

export const { sanityFetch } = defineLive({ client });
