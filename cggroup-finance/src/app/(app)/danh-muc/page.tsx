import { redirect } from "next/navigation";
import { CATALOGS } from "@/lib/catalog";

export default function Page() {
  redirect(`/danh-muc/${CATALOGS[0].key}`);
}
